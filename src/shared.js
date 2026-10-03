'use strict';

/*
 * 展厅 / 驻留（陈列关系）/ 共享照明（规则 19）。
 *
 * 模型：
 *  - galleries：展厅，以唯一“展厅标识”code 登记。
 *  - residencies：驻留（展品 × 展厅 × 起止区间）；同一展品驻留区间不得重叠（跨展厅同样约束）。
 *  - shared_lightings：一次展厅级“已发生”共享照明（实际照度为正、原因必填）。
 *  - shared_light_attributions：照明按“与各展品驻留区间的交集”逐展品归属；
 *      归属区间跨自然年拆分，窗内（该展品已批准/待复核计划开灯窗）部分按实际用光替代估算，
 *      窗外部分单独计量。归属一经生成永久保留，是“已被照明覆盖的驻留归属不得回改”的依据。
 *
 * 本模块不依赖 service.js 的顶层加载（在函数内延迟 require），避免与 service 形成循环依赖。
 */

const {
  ValidationError,
  ConflictError,
  parsePeriods,
  nonEmptyString,
} = require('./validation');
const {
  buildWindows,
  doseByYear,
  subtractIntervals,
  yearMapToObject,
  intersects,
  clipIntervalToWindows,
  round3,
  tsToWallString,
} = require('./dosing');

/** JSONB 兼容（真实 pg 给对象/数组，pg-mem 可能给字符串）。 */
function asJson(v, fallback = null) {
  if (v === null || v === undefined) return fallback;
  if (typeof v === 'string') {
    try {
      return JSON.parse(v);
    } catch (_) {
      return fallback;
    }
  }
  return v;
}

/** 复用 service 的日期规范化（保持与计划窗口径一致）。 */
function dateYmd(v) {
  if (typeof v === 'string') return v.slice(0, 10);
  if (v instanceof Date) {
    return `${v.getUTCFullYear()}-${String(v.getUTCMonth() + 1).padStart(2, '0')}-${String(
      v.getUTCDate()
    ).padStart(2, '0')}`;
  }
  return v;
}

function normalizePeriods(value) {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch (_) {
      throw new ValidationError('开灯时段数据格式无效');
    }
  }
  return value;
}

// ---------------------------------------------------------------------------
// 展厅
// ---------------------------------------------------------------------------

async function resolveGalleryRef(client, ref) {
  if (ref === undefined || ref === null || ref === '') {
    throw new ValidationError('缺少展厅标识（galleryCode 或 galleryId）');
  }
  if (typeof ref === 'number' || /^\d+$/.test(String(ref).trim())) {
    const row = (await client.query('SELECT * FROM galleries WHERE id = $1', [Number(ref)])).rows[0];
    if (!row) throw new ValidationError(`展厅不存在：#${ref}`);
    return row;
  }
  const code = String(ref).trim();
  const row = (await client.query('SELECT * FROM galleries WHERE code = $1', [code])).rows[0];
  if (!row) throw new ValidationError(`展厅不存在：${code}`);
  return row;
}

function serializeGallery(g, extras = {}) {
  return {
    id: Number(g.id),
    code: g.code,
    name: g.name,
    note: g.note,
    createdBy: g.created_by != null ? Number(g.created_by) : (g.createdBy ?? null),
    creatorName: g.creator_name != null ? g.creator_name : (g.creatorName ?? null),
    createdAt: g.created_at,
    ...extras,
  };
}

async function createGallery(client, { code, name, note }, actor) {
  const codeText = nonEmptyString(code, '展厅标识', 50);
  const nameText = nonEmptyString(name, '展厅名称', 200);
  const noteText = typeof note === 'string' && note.trim() !== '' ? note.trim().slice(0, 1000) : null;
  const exists = await client.query('SELECT id FROM galleries WHERE code = $1', [codeText]);
  if (exists.rows.length > 0) {
    throw new ConflictError(`展厅标识「${codeText}」已存在`, { existingGalleryId: exists.rows[0].id });
  }
  const inserted = await client.query(
    `INSERT INTO galleries (code, name, note, created_by)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [codeText, nameText, noteText, actor.userId]
  );
  return inserted.rows[0];
}

// ---------------------------------------------------------------------------
// 驻留
// ---------------------------------------------------------------------------

function serializeResidency(r) {
  return {
    id: Number(r.id),
    galleryId: Number(r.gallery_id != null ? r.gallery_id : r.galleryId),
    exhibitId: Number(r.exhibit_id != null ? r.exhibit_id : r.exhibitId),
    start: r.start != null ? r.start : tsToWallString(new Date(r.start_ts).getTime()),
    end: r.end != null ? r.end : tsToWallString(new Date(r.end_ts).getTime()),
    note: r.note,
    createdBy: r.created_by != null ? Number(r.created_by) : (r.createdBy ?? null),
    creatorName: r.creator_name != null ? r.creator_name : (r.creatorName ?? null),
    exhibitName: r.exhibit_name != null ? r.exhibit_name : (r.exhibitName ?? null),
    galleryCode: r.gallery_code != null ? r.gallery_code : (r.galleryCode ?? null),
    galleryName: r.gallery_name != null ? r.gallery_name : (r.galleryName ?? null),
    coveredByLighting: r.coveredByLighting !== undefined ? r.coveredByLighting :
      (r.covered_by_lighting != null ? Boolean(r.covered_by_lighting) : undefined),
    coveringLightingIds: asJson(r.covering_lighting_ids, undefined) ?? r.coveringLightingIds ?? null,
    createdAt: r.created_at,
  };
}

/** 驻留列表（可按展品 / 展厅过滤），附展厅、展品名称与“是否已被共享照明覆盖”。 */
async function listResidencies(client, { exhibitId = null, galleryId = null } = {}) {
  const { rows } = await client.query(
    `SELECT * FROM residencies
      WHERE ($1::bigint IS NULL OR exhibit_id = $1)
        AND ($2::bigint IS NULL OR gallery_id = $2)
      ORDER BY start_ts, id`,
    [exhibitId, galleryId]
  );
  if (rows.length === 0) return [];
  const galleryIds = [...new Set(rows.map((r) => Number(r.gallery_id)))];
  const exhibitIds = [...new Set(rows.map((r) => Number(r.exhibit_id)))];
  const galleryMap = new Map();
  const exhibitMap = new Map();
  if (galleryIds.length > 0) {
    const ph = galleryIds.map((_, i) => `$${i + 1}`).join(',');
    const { rows: gRows } = await client.query(
      `SELECT id, code, name FROM galleries WHERE id IN (${ph})`, galleryIds
    );
    for (const g of gRows) galleryMap.set(Number(g.id), g);
  }
  if (exhibitIds.length > 0) {
    const ph = exhibitIds.map((_, i) => `$${i + 1}`).join(',');
    const { rows: eRows } = await client.query(
      `SELECT id, name FROM exhibits WHERE id IN (${ph})`, exhibitIds
    );
    for (const e of eRows) exhibitMap.set(Number(e.id), e);
  }
  const ids = rows.map((r) => Number(r.id));
  const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
  const { rows: attrRows } = await client.query(
    `SELECT residency_id, shared_lighting_id
       FROM shared_light_attributions
      WHERE residency_id IN (${placeholders})`,
    ids
  );
  const covering = new Map();
  for (const a of attrRows) {
    const rid = Number(a.residency_id);
    if (!covering.has(rid)) covering.set(rid, []);
    covering.get(rid).push(Number(a.shared_lighting_id));
  }
  return rows.map((r) => {
    const g = galleryMap.get(Number(r.gallery_id));
    const e = exhibitMap.get(Number(r.exhibit_id));
    return {
      ...r,
      gallery_code: g ? g.code : null,
      gallery_name: g ? g.name : null,
      exhibit_name: e ? e.name : null,
      covered_by_lighting: covering.has(Number(r.id)),
      covering_lighting_ids: covering.get(Number(r.id)) || null,
    };
  });
}

/** 同展品与给定区间相交的既有驻留（排除自身），跨展厅一并检查。 */
async function findOverlappingResidencies(client, exhibitId, startMs, endMs, excludeId = null) {
  // 拆简单查询，规避个别内存驱动（pg-mem）对 JOIN + 时间不等式组合的缺陷
  const { rows } = await client.query(
    `SELECT * FROM residencies
      WHERE exhibit_id = $1
        AND ($4::bigint IS NULL OR id <> $4)
        AND start_ts < $3 AND end_ts > $2
      ORDER BY id`,
    [exhibitId, new Date(startMs), new Date(endMs), excludeId]
  );
  const galleryIds = [...new Set(rows.map((r) => Number(r.gallery_id)))];
  const galleryMap = new Map();
  if (galleryIds.length > 0) {
    const ph = galleryIds.map((_, i) => `$${i + 1}`).join(',');
    const { rows: gRows } = await client.query(
      `SELECT id, code, name FROM galleries WHERE id IN (${ph})`,
      galleryIds
    );
    for (const g of gRows) galleryMap.set(Number(g.id), g);
  }
  return rows.map((r) => {
    const g = galleryMap.get(Number(r.gallery_id));
    return { ...r, gallery_code: g ? g.code : null, gallery_name: g ? g.name : null };
  });
}

/**
 * 登记驻留（由路由在“展厅锁 → 展品锁”事务内调用）：
 *  - 展厅、展品必须存在；起点早于终点；
 *  - 同一展品驻留区间不得重叠（即使在不同展厅；端点相接允许）。
 */
async function registerResidency(client, { galleryId, exhibitId, startMs, endMs, note }, actor) {
  if (!(endMs > startMs)) throw new ValidationError('驻留起点须早于终点');
  const gallery = (await client.query('SELECT * FROM galleries WHERE id = $1 FOR UPDATE', [galleryId])).rows[0];
  if (!gallery) throw new ValidationError('展厅不存在');
  const exhibit = (await client.query('SELECT id FROM exhibits WHERE id = $1', [exhibitId])).rows[0];
  if (!exhibit) throw new ValidationError('展品不存在');

  const overlaps = await findOverlappingResidencies(client, exhibitId, startMs, endMs);
  if (overlaps.length > 0) {
    const items = overlaps.map((o) => ({
      id: Number(o.id),
      galleryCode: o.gallery_code,
      galleryName: o.gallery_name,
      start: tsToWallString(new Date(o.start_ts).getTime()),
      end: tsToWallString(new Date(o.end_ts).getTime()),
    }));
    throw new ConflictError(
      `展品 #${exhibitId} 的驻留区间与既有驻留 #${overlaps[0].id}（展厅「${overlaps[0].gallery_name}」，` +
        `${items[0].start} ~ ${items[0].end}）重叠，单件展品的驻留区间不得重叠`,
      { overlappingResidencies: items }
    );
  }

  const noteText = typeof note === 'string' && note.trim() !== '' ? note.trim().slice(0, 1000) : null;
  const inserted = await client.query(
    `INSERT INTO residencies (gallery_id, exhibit_id, start_ts, end_ts, note, created_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [galleryId, exhibitId, new Date(startMs), new Date(endMs), noteText, actor ? actor.userId : null]
  );
  return { row: inserted.rows[0], gallery };
}

/** 取驻留（可加行锁）。 */
async function getResidency(client, id, { lock = false } = {}) {
  const { rows } = await client.query(
    `SELECT * FROM residencies WHERE id = $1${lock ? ' FOR UPDATE' : ''}`,
    [id]
  );
  return rows[0] || null;
}

/** 该驻留已存在的共享照明归属（区间任一相交即视为已覆盖）。 */
async function attributionsOfResidency(client, residencyId) {
  const { rows } = await client.query(
    `SELECT * FROM shared_light_attributions
      WHERE residency_id = $1
      ORDER BY id`,
    [residencyId]
  );
  return rows;
}

/**
 * 修改驻留（仅起止/备注；改展厅/展品请删除后重登）。
 * 已被共享照明归属覆盖的驻留不得回改（409，列出覆盖它的共享照明编号）。
 */
async function updateResidency(client, residencyId, { startMs, endMs, note }) {
  const row = await getResidency(client, residencyId, { lock: true });
  if (!row) throw new ValidationError('驻留记录不存在');
  if (!(endMs > startMs)) throw new ValidationError('驻留起点须早于终点');

  const covered = await attributionsOfResidency(client, residencyId);
  if (covered.length > 0) {
    const ids = [...new Set(covered.map((c) => Number(c.shared_lighting_id)))].sort((a, b) => a - b);
    throw new ConflictError(
      `驻留 #${residencyId} 已被共享照明（#${ids.join('、#')}）覆盖，其归属不得回改；` +
        '如需调整陈列关系，请登记新的驻留区间',
      { coveredByLighting: true, coveringLightingIds: ids }
    );
  }

  const overlaps = await findOverlappingResidencies(
    client, row.exhibit_id, startMs, endMs, residencyId
  );
  if (overlaps.length > 0) {
    throw new ConflictError(
      `展品 #${row.exhibit_id} 的驻留区间与既有驻留 #${overlaps[0].id} 重叠，单件展品的驻留区间不得重叠`,
      {
        overlappingResidencies: overlaps.map((o) => ({
          id: Number(o.id),
          galleryCode: o.gallery_code,
          start: tsToWallString(new Date(o.start_ts).getTime()),
          end: tsToWallString(new Date(o.end_ts).getTime()),
        })),
      }
    );
  }

  const noteText = note === undefined
    ? row.note
    : (typeof note === 'string' && note.trim() !== '' ? note.trim().slice(0, 1000) : null);
  const updated = await client.query(
    `UPDATE residencies SET start_ts = $2, end_ts = $3, note = $4
      WHERE id = $1 RETURNING *`,
    [residencyId, new Date(startMs), new Date(endMs), noteText]
  );
  return updated.rows[0];
}

/** 删除尚未被共享照明覆盖的驻留；已覆盖的拒绝（409）。 */
async function deleteResidency(client, residencyId) {
  const row = await getResidency(client, residencyId, { lock: true });
  if (!row) throw new ValidationError('驻留记录不存在');
  const covered = await attributionsOfResidency(client, residencyId);
  if (covered.length > 0) {
    const ids = [...new Set(covered.map((c) => Number(c.shared_lighting_id)))].sort((a, b) => a - b);
    throw new ConflictError(
      `驻留 #${residencyId} 已被共享照明（#${ids.join('、#')}）覆盖，其归属不得回改或删除`,
      { coveredByLighting: true, coveringLightingIds: ids }
    );
  }
  await client.query('DELETE FROM residencies WHERE id = $1', [residencyId]);
}

// ---------------------------------------------------------------------------
// 共享照明视图（按展品）
// ---------------------------------------------------------------------------

/** 取某展品已批准/待复核计划行（口径与 service.getOccupyingPlans 一致，本地简单查询）。 */
async function getActivePlanRows(client, exhibitId) {
  const { rows } = await client.query(
    `SELECT * FROM plans
      WHERE exhibit_id = $1 AND status IN ('approved','pending_review')
      ORDER BY id`,
    [exhibitId]
  );
  return rows;
}

/** 由计划行构造开灯窗（本地实现，避免与 service 形成循环依赖）。 */
function windowsOfPlan(plan) {
  return buildWindows(dateYmd(plan.start_date), dateYmd(plan.end_date),
    parsePeriods(normalizePeriods(plan.light_periods)));
}

/** 构造某展品已批准/待复核计划的合并开灯窗（附 planId）。 */
async function exhibitPlanWindows(client, exhibitId) {
  const plans = await getActivePlanRows(client, exhibitId);
  const out = [];
  for (const plan of plans) {
    for (const w of windowsOfPlan(plan)) out.push({ ...w, planId: Number(plan.id) });
  }
  return { plans, planWindows: out };
}

/**
 * 读取某展品的全部共享照明归属（永久保留），构造占用视图：
 *  - items：逐条归属对外字段（含按年实际用光、窗内/窗外拆分、相交计划编号、来源共享照明与展厅）；
 *  - windows：归属区间 [{id,lightingId,galleryId,start,end,lux}]（供计划估算残余扣除窗内部分）。
 * 窗内/窗外按“当前”已批准/待复核计划开灯窗重算（计划取消后窗内部分自然变为窗外，
 * 归属的全额实际用光 yearly 不变）。
 */
async function loadSharedLightView(client, exhibitId) {
  const { rows } = await client.query(
    `SELECT * FROM shared_light_attributions
      WHERE exhibit_id = $1
      ORDER BY start_ts, id`,
    [exhibitId]
  );
  if (rows.length === 0) return { items: [], windows: [] };

  const lightingIds = [...new Set(rows.map((r) => Number(r.shared_lighting_id)))];
  const lPh = lightingIds.map((_, i) => `$${i + 1}`).join(',');
  const { rows: lightRows } = await client.query(
    `SELECT * FROM shared_lightings WHERE id IN (${lPh})`,
    lightingIds
  );
  const lightById = new Map(lightRows.map((l) => [Number(l.id), l]));

  const galleryIds = [...new Set(lightRows.map((l) => Number(l.gallery_id)))];
  const gPh = galleryIds.map((_, i) => `$${i + 1}`).join(',');
  const { rows: galleryRows } = await client.query(
    `SELECT id, code, name FROM galleries WHERE id IN (${gPh})`,
    galleryIds
  );
  const galleryById = new Map(galleryRows.map((g) => [Number(g.id), g]));

  const userIds = [...new Set(lightRows.map((l) => l.created_by).filter(Boolean))];
  const userMap = new Map();
  if (userIds.length > 0) {
    const uPh = userIds.map((_, i) => `$${i + 1}`).join(',');
    const { rows: userRows } = await client.query(
      `SELECT id, display_name FROM users WHERE id IN (${uPh})`,
      userIds
    );
    for (const u of userRows) userMap.set(Number(u.id), u.display_name);
  }

  const { planWindows: planWindowList } = await exhibitPlanWindows(client, exhibitId);

  const windows = [];
  const items = rows.map((row) => {
    const seg = { start: new Date(row.start_ts).getTime(), end: new Date(row.end_ts).getTime() };
    const lux = Number(row.actual_lux);
    const lighting = lightById.get(Number(row.shared_lighting_id));
    const gallery = galleryById.get(Number(row.gallery_id));
    windows.push({
      id: Number(row.id),
      lightingId: Number(row.shared_lighting_id),
      galleryId: Number(row.gallery_id),
      start: seg.start,
      end: seg.end,
      lux,
    });
    // 窗内/窗外以当前计划窗实时重算（与事故视图同构）；落库 JSON 仅作快照与无计划时兜底
    const insideParts = clipIntervalToWindows(seg, planWindowList);
    const outsideParts = subtractIntervals([seg], insideParts);
    const insidePlanIds = [...new Set(
      planWindowList.filter((w) => intersects(w, seg)).map((w) => w.planId)
    )].sort((a, b) => a - b);
    return {
      id: Number(row.id),
      lightingId: Number(row.shared_lighting_id),
      residencyId: Number(row.residency_id),
      exhibitId: Number(row.exhibit_id),
      galleryId: Number(row.gallery_id),
      galleryCode: gallery ? gallery.code : null,
      galleryName: gallery ? gallery.name : null,
      start: tsToWallString(seg.start),
      end: tsToWallString(seg.end),
      actualLux: lux,
      reason: lighting ? lighting.reason : null,
      createdBy: lighting ? lighting.created_by : null,
      creatorName: lighting && lighting.created_by ? userMap.get(Number(lighting.created_by)) || null : null,
      createdAt: lighting ? lighting.created_at : null,
      lightingStart: lighting
        ? tsToWallString(new Date(lighting.start_ts).getTime()) : null,
      lightingEnd: lighting
        ? tsToWallString(new Date(lighting.end_ts).getTime()) : null,
      yearly: yearMapToObject(doseByYear([seg], lux)),
      yearlyInside: yearMapToObject(doseByYear(insideParts, lux)),
      yearlyOutside: yearMapToObject(doseByYear(outsideParts, lux)),
      insidePlanIds,
    };
  });

  return { items, windows };
}

/** 取同展品与给定区间相交的共享照明归属（供后续实测/停灯/事故互斥校验）。 */
async function findOverlappingSharedLightAttributions(client, exhibitId, startMs, endMs, excludeAttributionId = null) {
  const { rows } = await client.query(
    `SELECT * FROM shared_light_attributions
      WHERE exhibit_id = $1
        AND ($4::bigint IS NULL OR id <> $4)
        AND start_ts < $3 AND end_ts > $2
      ORDER BY id`,
    [exhibitId, new Date(startMs), new Date(endMs), excludeAttributionId]
  );
  if (rows.length === 0) return [];
  const galleryIds = [...new Set(rows.map((r) => Number(r.gallery_id)))];
  const ph = galleryIds.map((_, i) => `$${i + 1}`).join(',');
  const { rows: gRows } = await client.query(
    `SELECT id, code, name FROM galleries WHERE id IN (${ph})`, galleryIds
  );
  const gMap = new Map(gRows.map((g) => [Number(g.id), g]));
  return rows.map((a) => {
    const g = gMap.get(Number(a.gallery_id));
    return { ...a, gallery_code: g ? g.code : null, gallery_name: g ? g.name : null };
  });
}

/** 把共享照明归属冲突行格式化为对外结构（与实测/停灯/事故冲突同形）。 */
function formatSharedConflicts(rows) {
  return rows.map((a) => ({
    attributionId: Number(a.id),
    sharedLightingId: Number(a.shared_lighting_id),
    galleryId: Number(a.gallery_id),
    galleryCode: a.gallery_code,
    galleryName: a.gallery_name,
    start: tsToWallString(new Date(a.start_ts).getTime()),
    end: tsToWallString(new Date(a.end_ts).getTime()),
  }));
}

// ---------------------------------------------------------------------------
// 共享照明登记
// ---------------------------------------------------------------------------

/**
 * 校验并登记一次展厅共享照明（由路由在“展厅锁 + 全部涉及展品锁”事务内调用）。
 * 规则：
 *  - 起点早于终点、结束不晚于当前（只登记已发生照明）、实际照度为正、原因必填（400）；
 *  - 照明按与该展厅各展品驻留区间的交集归属各展品；与任何驻留都无交集 → 409 拒绝；
 *  - 对每件展品，归属区间（照明∩驻留）不得与该展品未作废实测（含草稿）、停灯、
 *    计划外照明事故相交；任一展品冲突则整次登记拒绝，409 逐展品列出全部冲突；
 *  - 归属区间跨自然年拆分；窗内部分（计划开灯窗）按实际用光替代估算，窗外单独计量。
 * 返回 { lighting, gallery, attributions: [{exhibitId,residencyId,startMs,endMs,yearly,
 *          yearlyInside,yearlyOutside,insidePlanIds}] }。
 */
async function registerSharedLighting(client, { galleryId, startMs, endMs, actualLux, reason }, actor) {
  if (!(endMs > startMs)) throw new ValidationError('共享照明起点须早于终点');
  if (endMs > Date.now()) {
    throw new ValidationError(
      `共享照明结束时刻（${tsToWallString(endMs)}）晚于当前时间，照明尚未结束，不能登记`
    );
  }
  if (!(Number(actualLux) > 0)) throw new ValidationError('共享照明实际照度必须为正数');
  const reasonText = nonEmptyString(reason, '照明原因', 1000);

  // 1) 展厅存在并锁定（与并发驻留登记互斥）
  const gallery = (await client.query('SELECT * FROM galleries WHERE id = $1 FOR UPDATE', [galleryId])).rows[0];
  if (!gallery) throw new ValidationError('展厅不存在');

  // 2) 找出与照明区间相交的驻留（含展品名称），按展品分组；同展品多段驻留各自归属。
  //    拆简单查询，规避个别内存驱动对 JOIN + 时间不等式组合的缺陷。
  const { rows: residencyRowsPlain } = await client.query(
    `SELECT * FROM residencies
      WHERE gallery_id = $1 AND start_ts < $3 AND end_ts > $2
      ORDER BY id`,
    [galleryId, new Date(startMs), new Date(endMs)]
  );
  const exhibitNameMap = new Map();
  if (residencyRowsPlain.length > 0) {
    const exIds = [...new Set(residencyRowsPlain.map((r) => Number(r.exhibit_id)))];
    const ph = exIds.map((_, i) => `$${i + 1}`).join(',');
    const { rows: exRows } = await client.query(
      `SELECT id, name FROM exhibits WHERE id IN (${ph})`, exIds
    );
    for (const e of exRows) exhibitNameMap.set(Number(e.id), e.name);
  }
  const residencyRows = residencyRowsPlain.map((r) => ({
    ...r, exhibit_name: exhibitNameMap.get(Number(r.exhibit_id)) || null,
  }));
  if (residencyRows.length === 0) {
    throw new ConflictError(
      `照明时段 ${tsToWallString(startMs)} ~ ${tsToWallString(endMs)} 与展厅「${gallery.name}」` +
        `（${gallery.code}）的任何展品驻留区间都没有交集，不能登记共享照明`,
      { galleryId, galleryCode: gallery.code, overlappingResidencies: [] }
    );
  }

  // 每段驻留与照明的交集（各自单区间，相交结果至多一段）
  const clips = residencyRows.map((r) => ({
    residency: r,
    exhibitId: Number(r.exhibit_id),
    start: Math.max(startMs, new Date(r.start_ts).getTime()),
    end: Math.min(endMs, new Date(r.end_ts).getTime()),
  })).filter((c) => c.end > c.start);
  if (clips.length === 0) {
    throw new ConflictError('照明时段与该展厅的任何展品驻留区间都没有交集，不能登记共享照明', {
      galleryId, galleryCode: gallery.code, overlappingResidencies: [],
    });
  }

  // 3) 逐展品冲突核对（未作废实测含草稿 / 停灯 / 计划外事故），一次性收集全部冲突
  const exhibitIds = [...new Set(clips.map((c) => c.exhibitId))].sort((a, b) => a - b);
  const exhibitConflicts = [];
  for (const exhibitId of exhibitIds) {
    // 同一展品可能有多段驻留交集，合并成该展品在本次照明下的全部归属区间
    const segList = clips.filter((c) => c.exhibitId === exhibitId);
    const conflicts = {
      exhibitId,
      overlappingMeasurements: [],
      overlappingBlackouts: [],
      overlappingIncidents: [],
    };
    for (const seg of segList) {
      const p1 = seg.start, p2 = seg.end;
      const meas = await client.query(
        `SELECT id, plan_id, start_ts, end_ts, status
           FROM measurements
          WHERE exhibit_id = $1 AND status <> 'annulled'
            AND start_ts < $3 AND end_ts > $2
          ORDER BY id`,
        [exhibitId, new Date(p1), new Date(p2)]
      );
      for (const m of meas.rows) {
        if (conflicts.overlappingMeasurements.some((x) => x.id === m.id)) continue;
        conflicts.overlappingMeasurements.push({
          id: m.id,
          planId: m.plan_id,
          status: m.status,
          start: tsToWallString(new Date(m.start_ts).getTime()),
          end: tsToWallString(new Date(m.end_ts).getTime()),
        });
      }
      const blacks = await client.query(
        `SELECT id, plan_id, start_ts, end_ts FROM blackouts
          WHERE exhibit_id = $1 AND start_ts < $3 AND end_ts > $2
          ORDER BY id`,
        [exhibitId, new Date(p1), new Date(p2)]
      );
      const blackoutPlanIds = [...new Set(blacks.rows.map((b) => Number(b.plan_id)))];
      const titleMap = new Map();
      if (blackoutPlanIds.length > 0) {
        const ph = blackoutPlanIds.map((_, i) => `$${i + 1}`).join(',');
        const tRows = await client.query(
          `SELECT id, title FROM plans WHERE id IN (${ph})`,
          blackoutPlanIds
        );
        for (const t of tRows.rows) titleMap.set(Number(t.id), t.title);
      }
      for (const b of blacks.rows) {
        if (conflicts.overlappingBlackouts.some((x) => x.id === b.id)) continue;
        conflicts.overlappingBlackouts.push({
          id: b.id,
          planId: b.plan_id,
          planTitle: titleMap.get(Number(b.plan_id)) || null,
          start: tsToWallString(new Date(b.start_ts).getTime()),
          end: tsToWallString(new Date(b.end_ts).getTime()),
        });
      }
      const incs = await client.query(
        `SELECT id, start_ts, end_ts FROM lighting_incidents
          WHERE exhibit_id = $1 AND start_ts < $3 AND end_ts > $2
          ORDER BY id`,
        [exhibitId, new Date(p1), new Date(p2)]
      );
      for (const x of incs.rows) {
        if (conflicts.overlappingIncidents.some((y) => y.id === x.id)) continue;
        conflicts.overlappingIncidents.push({
          id: x.id,
          start: tsToWallString(new Date(x.start_ts).getTime()),
          end: tsToWallString(new Date(x.end_ts).getTime()),
        });
      }
    }
    if (conflicts.overlappingMeasurements.length ||
        conflicts.overlappingBlackouts.length ||
        conflicts.overlappingIncidents.length) {
      exhibitConflicts.push(conflicts);
    }
  }

  if (exhibitConflicts.length > 0) {
    const parts = [];
    for (const c of exhibitConflicts) {
      const sub = [];
      for (const m of c.overlappingMeasurements) {
        sub.push(`与${m.status === 'draft' ? '待确认' : '已确认'}实测 #${m.id}（${m.start} ~ ${m.end}）相交`);
      }
      for (const b of c.overlappingBlackouts) {
        sub.push(`与停灯记录 #${b.id}（计划「${b.planTitle}」，${b.start} ~ ${b.end}）相交`);
      }
      for (const x of c.overlappingIncidents) {
        sub.push(`与计划外照明事故 #${x.id}（${x.start} ~ ${x.end}）相交`);
      }
      parts.push(`展品 #${c.exhibitId}：${sub.join('；')}`);
    }
    throw new ConflictError(
      `共享照明登记失败：${parts.join('；')}，整次登记未保存`,
      { galleryId, galleryCode: gallery.code, exhibitConflicts }
    );
  }

  // 4) 落库：共享照明主记录 + 逐展品归属（窗内/窗外按当前计划窗拆分）
  const lightInsert = await client.query(
    `INSERT INTO shared_lightings (gallery_id, start_ts, end_ts, actual_lux, reason, created_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [galleryId, new Date(startMs), new Date(endMs), actualLux, reasonText, actor.userId]
  );
  const lighting = lightInsert.rows[0];
  const lightingId = Number(lighting.id);

  const { planWindowsByExhibit } = await buildPlanWindowsMap(client, exhibitIds);

  const attributions = [];
  for (const clip of clips) {
    const seg = { start: clip.start, end: clip.end };
    const planWins = planWindowsByExhibit.get(clip.exhibitId) || [];
    const insideParts = clipIntervalToWindows(seg, planWins);
    const outsideParts = subtractIntervals([seg], insideParts);
    const insidePlanIds = [...new Set(
      planWins.filter((w) => intersects(w, seg)).map((w) => w.planId)
    )].sort((a, b) => a - b);
    const yearly = yearMapToObject(doseByYear([seg], actualLux));
    const yearlyInside = yearMapToObject(doseByYear(insideParts, actualLux));
    const yearlyOutside = yearMapToObject(doseByYear(outsideParts, actualLux));

    const ins = await client.query(
      `INSERT INTO shared_light_attributions
         (shared_lighting_id, residency_id, gallery_id, exhibit_id,
          start_ts, end_ts, actual_lux,
          yearly_json, yearly_inside_json, yearly_outside_json, inside_plan_ids)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb)
       RETURNING *`,
      [
        lightingId, clip.residency.id, galleryId, clip.exhibitId,
        new Date(seg.start), new Date(seg.end), actualLux,
        JSON.stringify(yearly), JSON.stringify(yearlyInside),
        JSON.stringify(yearlyOutside), JSON.stringify(insidePlanIds),
      ]
    );
    attributions.push({
      attributionId: Number(ins.rows[0].id),
      residencyId: Number(clip.residency.id),
      exhibitId: clip.exhibitId,
      startMs: seg.start,
      endMs: seg.end,
      yearly,
      yearlyInside,
      yearlyOutside,
      insidePlanIds,
    });
  }

  return { lighting, gallery, attributions };
}

/** 批量构造多件展品当前已批准/待复核计划开灯窗（附 planId）。 */
async function buildPlanWindowsMap(client, exhibitIds) {
  const map = new Map();
  for (const exhibitId of exhibitIds) {
    const { planWindows: wins } = await exhibitPlanWindows(client, exhibitId);
    map.set(exhibitId, wins);
  }
  return { planWindowsByExhibit: map };
}

// ---------------------------------------------------------------------------
// 共享照明列表 / 详情
// ---------------------------------------------------------------------------

/** 共享照明主记录列表（可按展厅过滤），附展厅字段与登记人。 */
async function listSharedLightingRows(client, { galleryId = null } = {}) {
  const { rows } = await client.query(
    `SELECT * FROM shared_lightings
      WHERE ($1::bigint IS NULL OR gallery_id = $1)
      ORDER BY start_ts DESC, id DESC`,
    [galleryId]
  );
  if (rows.length === 0) return [];
  const galleryIds = [...new Set(rows.map((r) => Number(r.gallery_id)))];
  const gPh = galleryIds.map((_, i) => `$${i + 1}`).join(',');
  const { rows: gRows } = await client.query(
    `SELECT id, code, name FROM galleries WHERE id IN (${gPh})`, galleryIds
  );
  const gMap = new Map(gRows.map((g) => [Number(g.id), g]));
  const userIds = [...new Set(rows.map((r) => r.created_by).filter(Boolean))];
  const userMap = new Map();
  if (userIds.length > 0) {
    const uPh = userIds.map((_, i) => `$${i + 1}`).join(',');
    const { rows: uRows } = await client.query(
      `SELECT id, display_name FROM users WHERE id IN (${uPh})`, userIds
    );
    for (const u of uRows) userMap.set(Number(u.id), u.display_name);
  }
  return rows.map((r) => {
    const g = gMap.get(Number(r.gallery_id));
    return {
      ...r,
      gallery_code: g ? g.code : null,
      gallery_name: g ? g.name : null,
      creator_name: r.created_by ? userMap.get(Number(r.created_by)) || null : null,
    };
  });
}

/** 一次共享照明的全部归属行。 */
async function getAttributionRowsByLighting(client, lightingId) {
  const { rows } = await client.query(
    `SELECT * FROM shared_light_attributions WHERE shared_lighting_id = $1 ORDER BY id`,
    [lightingId]
  );
  return rows;
}

/** 序列化共享照明主记录 + 归属摘要（用于列表/详情）。 */
async function serializeSharedLighting(client, row, { withAttributions = true } = {}) {
  const out = {
    id: Number(row.id),
    galleryId: Number(row.gallery_id),
    galleryCode: row.gallery_code,
    galleryName: row.gallery_name,
    start: tsToWallString(new Date(row.start_ts).getTime()),
    end: tsToWallString(new Date(row.end_ts).getTime()),
    actualLux: Number(row.actual_lux),
    reason: row.reason,
    createdBy: row.created_by != null ? Number(row.created_by) : null,
    creatorName: row.creator_name || null,
    createdAt: row.created_at,
  };
  if (withAttributions) {
    const attrRows = await getAttributionRowsByLighting(client, Number(row.id));
    // 展品名批量查
    const exhibitIds = [...new Set(attrRows.map((a) => Number(a.exhibit_id)))];
    const nameMap = new Map();
    if (exhibitIds.length > 0) {
      const ph = exhibitIds.map((_, i) => `$${i + 1}`).join(',');
      const { rows: exRows } = await client.query(
        `SELECT id, name FROM exhibits WHERE id IN (${ph})`,
        exhibitIds
      );
      for (const e of exRows) nameMap.set(Number(e.id), e.name);
    }
    out.attributions = attrRows.map((a) => ({
      attributionId: Number(a.id),
      residencyId: Number(a.residency_id),
      exhibitId: Number(a.exhibit_id),
      exhibitName: nameMap.get(Number(a.exhibit_id)) || null,
      start: tsToWallString(new Date(a.start_ts).getTime()),
      end: tsToWallString(new Date(a.end_ts).getTime()),
      actualLux: Number(a.actual_lux),
      yearly: asJson(a.yearly_json, {}) || {},
      yearlyInside: asJson(a.yearly_inside_json, {}) || {},
      yearlyOutside: asJson(a.yearly_outside_json, {}) || {},
      insidePlanIds: asJson(a.inside_plan_ids, []) || [],
    }));
  }
  return out;
}

/** 展厅详情：附驻留（带覆盖标记）与共享照明列表。 */
async function galleryDetail(client, gallery) {
  const residencies = await listResidencies(client, { galleryId: Number(gallery.id) });
  const lightRows = await listSharedLightingRows(client, { galleryId: Number(gallery.id) });
  const lightings = [];
  for (const lr of lightRows) {
    lightings.push(await serializeSharedLighting(client, lr));
  }
  return {
    ...serializeGallery(gallery),
    residencies: residencies.map(serializeResidency),
    sharedLightings: lightings,
  };
}

module.exports = {
  asJson,
  dateYmd,
  normalizePeriods,
  // galleries
  resolveGalleryRef,
  serializeGallery,
  createGallery,
  galleryDetail,
  // residencies
  serializeResidency,
  listResidencies,
  findOverlappingResidencies,
  registerResidency,
  getResidency,
  attributionsOfResidency,
  updateResidency,
  deleteResidency,
  // shared light view
  loadSharedLightView,
  findOverlappingSharedLightAttributions,
  formatSharedConflicts,
  // registration
  registerSharedLighting,
  // listing
  listSharedLightingRows,
  serializeSharedLighting,
  // dosing helpers reused by service
  buildWindows,
  parsePeriods,
  round3,
};
