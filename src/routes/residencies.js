'use strict';

/*
 * 驻留（陈列关系）路由（规则 19）。
 *   GET  /api/residencies                 登录用户：驻留列表（?exhibitId=&galleryId=）
 *   GET  /api/residencies/:id             登录用户：驻留详情
 *   POST /api/residencies                 保管员：以展厅标识、展品编号与驻留起止登记陈列关系
 *   PUT  /api/residencies/:id             保管员：修改未被共享照明覆盖的驻留起止/备注
 *   DELETE /api/residencies/:id           保管员：删除未被共享照明覆盖的驻留
 *
 * 不变量：单件展品的驻留区间不得重叠（跨展厅同样约束；端点相接允许）；
 * 已被共享照明归属覆盖的驻留不得回改或删除（409，列出覆盖它的共享照明编号）。
 *
 * 锁顺序：先展厅键锁（与共享照明登记串行），再展品键锁（与同展品额度操作串行），
 * 与共享照明登记的加锁顺序一致，避免死锁。
 */

const express = require('express');
const { query, withTransaction, withKeyLock } = require('../db');
const { requireRole } = require('../auth');
const { recordAudit } = require('../audit');
const {
  ValidationError,
  assertDate,
  parseTimeToMinutes,
} = require('../validation');
const { wallToTs, tsToWallString } = require('../dosing');
const {
  resolveGalleryRef,
  registerResidency,
  listResidencies,
  getResidency,
  updateResidency,
  deleteResidency,
  serializeResidency,
} = require('../shared');

const router = express.Router();

router.use(require('../auth').requireAuth);

/**
 * 解析驻留起止：开始/结束均为“日期 + 可选时刻”。
 * 时刻缺省时开始按当日 00:00、结束按次日 00:00（即含结束日整天，左闭右开）。
 */
function parseIntervalBody(body, fieldPrefix) {
  void fieldPrefix;
  const startDate = assertDate(body.startDate, '驻留开始日期');
  const endDate = assertDate(body.endDate, '驻留结束日期');
  if (endDate < startDate) throw new ValidationError('驻留结束日期不能早于开始日期');
  const startMinute = body.startTime !== undefined && body.startTime !== null && body.startTime !== ''
    ? parseTimeToMinutes(body.startTime) : 0;
  const endMinute = body.endTime !== undefined && body.endTime !== null && body.endTime !== ''
    ? parseTimeToMinutes(body.endTime) : 0;
  return {
    startMs: wallToTs(startDate, startMinute),
    // 结束未给时刻：以次日 00:00 作为半开区间右端，覆盖结束日全天
    endMs: wallToTs(endDate, endMinute) +
      (body.endTime === undefined || body.endTime === null || body.endTime === '' ? 86400000 : 0),
  };
}

/** 驻留列表（登录可读；按展品或展厅过滤）。 */
router.get('/', async (req, res, next) => {
  try {
    const exhibitId = req.query.exhibitId !== undefined ? Number(req.query.exhibitId) : null;
    const galleryId = req.query.galleryId !== undefined ? Number(req.query.galleryId) : null;
    if (exhibitId !== null && !Number.isInteger(exhibitId)) {
      throw new ValidationError('展品 ID 无效');
    }
    if (galleryId !== null && !Number.isInteger(galleryId)) {
      throw new ValidationError('展厅 ID 无效');
    }
    const rows = await listResidencies({ query }, { exhibitId, galleryId });
    res.json({ residencies: rows.map(serializeResidency) });
  } catch (err) {
    next(err);
  }
});

/** 驻留详情（登录可读）。 */
router.get('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new ValidationError('驻留 ID 无效');
    const rows = await listResidencies({ query }, {});
    const row = rows.find((x) => Number(x.id) === id);
    if (!row) throw new ValidationError('驻留记录不存在');
    res.json({ residency: serializeResidency(row) });
  } catch (err) {
    next(err);
  }
});

/**
 * 保管员登记驻留：
 *  - 展厅以 galleryCode（展厅标识）或 galleryId 指定，须存在；
 *  - exhibitId 须为既有展品；起止正时长；
 *  - 同一展品驻留区间不得重叠（即使跨展厅）。
 */
router.post('/', requireRole('conservator'), async (req, res, next) => {
  try {
    const body = req.body || {};
    const exhibitId = Number(body.exhibitId);
    if (!Number.isInteger(exhibitId) || exhibitId <= 0) {
      throw new ValidationError('展品编号（exhibitId）无效');
    }
    const interval = parseIntervalBody(body);
    const note = typeof body.note === 'string' ? body.note : null;

    // 先解析展厅（锁外只读校验存在性），再按“展厅 → 展品”顺序取键锁开事务
    const gallery = await resolveGalleryRef({ query },
      body.galleryCode !== undefined ? body.galleryCode : body.galleryId);
    const galleryId = Number(gallery.id);

    const result = await withKeyLock(`gallery:${galleryId}`, () =>
      withKeyLock(`exhibit:${exhibitId}`, () =>
        withTransaction(async (client) => {
          const { row, gallery: g } = await registerResidency(
            client,
            { galleryId, exhibitId, startMs: interval.startMs, endMs: interval.endMs, note },
            req.sessionUser
          );
          await recordAudit(client, req.sessionUser, 'residency.create', 'residency', row.id, {
            galleryId, galleryCode: g.code, exhibitId,
            start: tsToWallString(interval.startMs),
            end: tsToWallString(interval.endMs),
          });
          return row;
        })
      )
    );

    res.status(201).json({
      residency: serializeResidency({
        ...result,
        gallery_code: gallery.code,
        gallery_name: gallery.name,
        covered_by_lighting: false,
        covering_lighting_ids: null,
      }),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * 保管员修改驻留（仅起止/备注）：已被共享照明覆盖的驻留拒绝（409）。
 */
router.put('/:id', requireRole('conservator'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new ValidationError('驻留 ID 无效');
    const existing = await getResidency({ query }, id);
    if (!existing) throw new ValidationError('驻留记录不存在');
    const galleryId = Number(existing.gallery_id);
    const exhibitId = Number(existing.exhibit_id);

    const body = req.body || {};
    // 缺省沿用原值
    const filled = {
      startDate: body.startDate !== undefined ? body.startDate
        : tsToWallString(new Date(existing.start_ts).getTime()).slice(0, 10),
      startTime: body.startTime !== undefined ? body.startTime
        : tsToWallString(new Date(existing.start_ts).getTime()).slice(11, 16),
      endDate: body.endDate !== undefined ? body.endDate
        : tsToWallString(new Date(existing.end_ts).getTime() - 86400000).slice(0, 10),
      endTime: body.endTime !== undefined ? body.endTime
        : tsToWallString(new Date(existing.end_ts).getTime() - 86400000).slice(11, 16),
    };
    // 若原本结束恰为 00:00（按整日登记），缺省改回整日语义
    const interval = parseIntervalBody(filled);

    const updated = await withKeyLock(`gallery:${galleryId}`, () =>
      withKeyLock(`exhibit:${exhibitId}`, () =>
        withTransaction(async (client) => {
          const row = await updateResidency(
            client, id,
            {
              startMs: interval.startMs,
              endMs: interval.endMs,
              note: typeof body.note === 'string' ? body.note : undefined,
            }
          );
          await recordAudit(client, req.sessionUser, 'residency.update', 'residency', id, {
            galleryId, exhibitId,
            start: tsToWallString(interval.startMs),
            end: tsToWallString(interval.endMs),
          });
          return row;
        })
      )
    );

    const rows = await listResidencies({ query }, {});
    const fresh = rows.find((x) => Number(x.id) === id);
    res.json({ residency: serializeResidency(fresh || updated) });
  } catch (err) {
    next(err);
  }
});

/**
 * 保管员删除驻留：已被共享照明覆盖的驻留拒绝（409）。
 */
router.delete('/:id', requireRole('conservator'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new ValidationError('驻留 ID 无效');
    const existing = await getResidency({ query }, id);
    if (!existing) throw new ValidationError('驻留记录不存在');
    const galleryId = Number(existing.gallery_id);
    const exhibitId = Number(existing.exhibit_id);

    await withKeyLock(`gallery:${galleryId}`, () =>
      withKeyLock(`exhibit:${exhibitId}`, () =>
        withTransaction(async (client) => {
          await deleteResidency(client, id);
          await recordAudit(client, req.sessionUser, 'residency.delete', 'residency', id, {
            galleryId, exhibitId,
          });
        })
      )
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = { router };
