'use strict';

/*
 * 共享照明路由（规则 19）。
 *   GET  /api/shared-lightings        登录用户：共享照明列表（?galleryId=&galleryCode=&exhibitId=）
 *   GET  /api/shared-lightings/:id    登录用户：一次共享照明详情（含逐展品归属）
 *   POST /api/shared-lightings        保管员：登记一次展厅级已发生共享照明
 *
 * 登记规则：
 *   - 以展厅标识（galleryCode 或 galleryId）、已发生的照明起止、正数实际照度、非空原因登记；
 *   - 未知展厅/展品、起止无效（结束不晚于开始）、照明尚未结束（结束晚于当前）拒绝（400）；
 *   - 照明按与各展品驻留区间的交集归属各展品并跨自然年拆分；无任何展品交集时拒绝（409）；
 *   - 与任一展品未作废实测（含草稿）、停灯或已有照明事故相交时，整次登记拒绝（409，逐展品列冲突）；
 *   - 多展品计量及超限引发的待复核变更在同一事务原子生效；超限仍入账，返回各展品超额年份；
 *   - 窗内（计划开灯窗）部分按实际用光替代估算，窗外部分单独计量，不释放计划排期；
 *   - 共享照明永久保留，不提供修改/删除（PUT/DELETE/:id 返回 400）。
 */

const express = require('express');
const { query, withTransaction, withKeyLock } = require('../db');
const { requireRole } = require('../auth');
const { recordAudit } = require('../audit');
const {
  ValidationError,
  assertDate,
  positiveNumber,
  parseTimeToMinutes,
  nonEmptyString,
} = require('../validation');
const { wallToTs, tsToWallString } = require('../dosing');
const {
  resolveGalleryRef,
  registerSharedLighting,
  listSharedLightingRows,
  serializeSharedLighting,
} = require('../shared');
const { computeOccupancy, getOccupyingPlans, plansToFlag } = require('../service');

const router = express.Router();

router.use(require('../auth').requireAuth);

/** 解析共享照明请求体起止（时刻必填，与实测/事故接口同形）。 */
function parseLightingBody(body) {
  const startDate = assertDate(body.startDate, '照明开始日期');
  const endDate = body.endDate ? assertDate(body.endDate, '照明结束日期') : startDate;
  const startMinute = parseTimeToMinutes(body.startTime);
  const endMinute = parseTimeToMinutes(body.endTime);
  if (endDate < startDate) throw new ValidationError('照明结束日期不能早于开始日期');
  const actualLux = positiveNumber(body.actualLux, '实际照度（lx）', { max: 1000000 });
  return {
    startMs: wallToTs(startDate, startMinute),
    endMs: wallToTs(endDate, endMinute),
    actualLux,
  };
}

/**
 * 按“展厅 → 展品 id 升序”逐个取得键锁后开事务（与驻留登记、联合核准同构，避免死锁）。
 * 事务内同样先锁展厅行，再按展品 id 升序锁展品行。
 */
async function withGalleryAndExhibitsTransaction(galleryId, exhibitIds, work) {
  const ids = [...new Set(exhibitIds.map(Number))].sort((a, b) => a - b);
  const runExhibitLocks = (idx) => {
    if (idx >= ids.length) {
      return withTransaction(async (client) => {
        await client.query('SELECT id FROM galleries WHERE id = $1 FOR UPDATE', [galleryId]);
        for (const exId of ids) {
          await client.query('SELECT id FROM exhibits WHERE id = $1 FOR UPDATE', [exId]);
        }
        return work(client);
      });
    }
    return withKeyLock(`exhibit:${ids[idx]}`, () => runExhibitLocks(idx + 1));
  };
  // 先展厅键锁，再逐展品键锁，与驻留登记的加锁顺序一致
  return withKeyLock(`gallery:${galleryId}`, () => runExhibitLocks(0));
}

/**
 * 共享照明列表（登录可读）。
 * 过滤：galleryId / galleryCode / exhibitId（取与该展品有归属的照明）。
 */
router.get('/', async (req, res, next) => {
  try {
    let galleryId = null;
    if (req.query.galleryId !== undefined) {
      galleryId = Number(req.query.galleryId);
      if (!Number.isInteger(galleryId)) throw new ValidationError('展厅 ID 无效');
    } else if (req.query.galleryCode !== undefined) {
      const g = await resolveGalleryRef({ query }, req.query.galleryCode);
      galleryId = Number(g.id);
    }
    let exhibitId = null;
    if (req.query.exhibitId !== undefined) {
      exhibitId = Number(req.query.exhibitId);
      if (!Number.isInteger(exhibitId)) throw new ValidationError('展品 ID 无效');
    }

    let rows;
    if (exhibitId !== null) {
      const { rows: idRows } = await query(
        `SELECT DISTINCT shared_lighting_id FROM shared_light_attributions WHERE exhibit_id = $1`,
        [exhibitId]
      );
      if (idRows.length === 0) {
        rows = [];
      } else {
        const all = await listSharedLightingRows({ query }, {});
        const ids = new Set(idRows.map((r) => Number(r.shared_lighting_id)));
        rows = all.filter((x) => ids.has(Number(x.id)));
      }
    } else {
      rows = await listSharedLightingRows({ query }, { galleryId });
    }

    const items = [];
    for (const row of rows) {
      let item = await serializeSharedLighting({ query }, row);
      if (exhibitId !== null) {
        item.attributions = item.attributions.filter((a) => a.exhibitId === exhibitId);
      }
      items.push(item);
    }
    res.json({ sharedLightings: items });
  } catch (err) {
    next(err);
  }
});

/** 共享照明详情（登录可读）。 */
router.get('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new ValidationError('共享照明 ID 无效');
    const rows = await listSharedLightingRows({ query }, {});
    const row = rows.find((x) => Number(x.id) === id);
    if (!row) throw new ValidationError('共享照明记录不存在');
    const sharedLighting = await serializeSharedLighting({ query }, row);
    res.json({ sharedLighting });
  } catch (err) {
    next(err);
  }
});

/**
 * 保管员登记共享照明：
 *  - 输入/时间类错误 400；无驻留交集或与实测/停灯/事故相交 409，整次登记不保存；
 *  - 多展品计量与超限待复核变更原子生效；超限仍入账，返回 409 并列出各展品超额年份；
 *  - 成功（无超额）201 返回 { ok, sharedLighting, exhibits:[{exhibitId,detail,overflows}] }。
 */
router.post('/', requireRole('conservator'), async (req, res, next) => {
  try {
    const body = req.body || {};
    const interval = parseLightingBody(body);
    const reason = nonEmptyString(body.reason, '照明原因', 1000);

    // 锁外只读解析展厅
    const gallery = await resolveGalleryRef({ query },
      body.galleryCode !== undefined ? body.galleryCode : body.galleryId);
    const galleryId = Number(gallery.id);

    // 先在无锁只读连接上预取有驻留交集的展品，用于确定要锁哪些展品行；
    // 真正的区间归属与全部冲突在加锁事务内重新计算。
    const pre = await query(
      `SELECT DISTINCT exhibit_id FROM residencies
        WHERE gallery_id = $1 AND start_ts < $3 AND end_ts > $2`,
      [galleryId, new Date(interval.startMs), new Date(interval.endMs)]
    );
    const preExhibitIds = pre.rows.map((r) => Number(r.exhibit_id)).sort((a, b) => a - b);

    const out = await withGalleryAndExhibitsTransaction(galleryId, preExhibitIds, async (client) => {
      const reg = await registerSharedLighting(
        client,
        { galleryId, startMs: interval.startMs, endMs: interval.endMs,
          actualLux: interval.actualLux, reason },
        req.sessionUser
      );
      const lightingId = Number(reg.lighting.id);
      const exhibitIds = [...new Set(reg.attributions.map((a) => a.exhibitId))].sort((a, b) => a - b);

      await recordAudit(client, req.sessionUser, 'shared_lighting.create',
        'shared_lighting', lightingId, {
          galleryId,
          galleryCode: reg.gallery.code,
          start: tsToWallString(interval.startMs),
          end: tsToWallString(interval.endMs),
          actualLux: interval.actualLux,
          reason,
          exhibits: reg.attributions.map((a) => ({
            exhibitId: a.exhibitId,
            residencyId: a.residencyId,
            yearly: a.yearly,
            yearlyInside: a.yearlyInside,
            yearlyOutside: a.yearlyOutside,
            insidePlanIds: a.insidePlanIds,
          })),
        });

      // 逐展品重算占用、判定超额并把相关年度尚未开始且有估算残余的已批准计划转待复核
      const exhibits = [];
      for (const exhibitId of exhibitIds) {
        const attr = reg.attributions.filter((a) => a.exhibitId === exhibitId);
        const candidateYears = new Set();
        for (const a of attr) {
          for (const y of Object.keys(a.yearly)) candidateYears.add(Number(y));
        }
        const occupancy = await computeOccupancy(client, exhibitId);
        const overflows = [];
        const overflowYears = [];
        for (const year of candidateYears) {
          const info = occupancy.years[String(year)];
          if (!info || info.limit === null) continue;
          if (info.over) {
            overflowYears.push(year);
            overflows.push({
              year,
              limit: info.limit,
              projected: info.used,
              excess: Math.round((info.used - info.limit) * 1000) / 1000,
            });
          }
        }

        let flaggedPlans = [];
        if (overflowYears.length > 0) {
          const activePlans = await getOccupyingPlans(client, exhibitId);
          const targets = plansToFlag(activePlans, occupancy, overflowYears, Date.now());
          for (const { plan: fp, firstStart } of targets) {
            const reasonText =
              `共享照明 #${lightingId}（展厅「${reg.gallery.name}」，${tsToWallString(interval.startMs)} ~ ` +
              `${tsToWallString(interval.endMs)}）登记后导致 ${overflowYears.join('、')} 年额度超限，转待复核`;
            await client.query(
              `UPDATE plans SET status = 'pending_review', review_reason = $2, updated_at = now()
                WHERE id = $1 AND status = 'approved'`,
              [fp.id, reasonText]
            );
            await recordAudit(client, req.sessionUser, 'plan.flag_review_shared_lighting',
              'plan', fp.id, { triggerSharedLightingId: lightingId, overflowYears });
            flaggedPlans.push({
              id: fp.id,
              title: fp.title,
              firstStart: tsToWallString(firstStart),
              overflowYears,
            });
          }
        }

        const { exhibitDetail } = require('./exhibits');
        const detail = await exhibitDetail(client, exhibitId, { lock: true });
        exhibits.push({ exhibitId, detail, overflows, flaggedPlans });
      }

      const sharedLighting = await serializeSharedLighting(client, reg.lighting);
      return { sharedLighting, exhibits, gallery: reg.gallery };
    });

    const allOverflows = out.exhibits.flatMap((e) =>
      e.overflows.map((o) => ({ exhibitId: e.exhibitId, ...o }))
    );

    if (allOverflows.length > 0) {
      // 多展品计量已原子入账：409 报告各展品超额年份与被转待复核计划（超限仍生效）
      const flaggedPlans = out.exhibits.flatMap((e) =>
        e.flaggedPlans.map((f) => ({ exhibitId: e.exhibitId, ...f }))
      );
      return res.status(409).json({
        message:
          `共享照明 #${out.sharedLighting.id} 已登记并计入各展品实际用光，但登记后超限：` +
          out.exhibits
            .filter((e) => e.overflows.length > 0)
            .map((e) =>
              `展品 #${e.exhibitId} ` +
              e.overflows.map((o) => `${o.year} 年超出 ${o.excess} lx·h`).join('、')
            )
            .join('；') +
          (flaggedPlans.length
            ? `。已将 ${flaggedPlans.length} 条尚未开始的计划转为待复核`
            : '；相关年度没有尚未开始的已批准计划'),
        sharedLighting: out.sharedLighting,
        overflows: allOverflows,
        flaggedPlans,
        exhibits: out.exhibits.map((e) => ({
          exhibitId: e.exhibitId,
          overflows: e.overflows,
          flaggedPlans: e.flaggedPlans,
          detail: e.detail,
        })),
      });
    }

    // 单展品成功响应与既有事故接口同构（展品详情字段位于顶层）；多展品返回 exhibits 数组
    if (out.exhibits.length === 1) {
      return res.status(201).json({
        ...out.exhibits[0].detail,
        sharedLighting: out.sharedLighting,
      });
    }
    res.status(201).json({
      ok: true,
      sharedLighting: out.sharedLighting,
      exhibits: out.exhibits.map((e) => ({
        exhibitId: e.exhibitId,
        detail: e.detail,
        overflows: e.overflows,
        flaggedPlans: e.flaggedPlans,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// 共享照明永久保留：不提供修改/删除接口，显式拒绝并给出中文原因。
router.all('/:id', (req, _res, next) => {
  next(new ValidationError(`共享照明记录保留，不可${req.method === 'DELETE' ? '删除' : '修改'}`));
});

module.exports = { router };
