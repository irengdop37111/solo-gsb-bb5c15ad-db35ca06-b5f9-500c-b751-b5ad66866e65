'use strict';

/*
 * 展厅路由（规则 19）。
 *   GET  /api/galleries        登录用户：展厅列表（附驻留/共享照明计数）
 *   POST /api/galleries        保管员：登记展厅（唯一展厅标识 code）
 *   GET  /api/galleries/:ref   登录用户：展厅详情（:ref 可为展厅标识 code 或数字 id；
 *                              附驻留（含是否已被共享照明覆盖）与共享照明列表）
 */

const express = require('express');
const { query } = require('../db');
const { requireRole } = require('../auth');
const { recordAudit } = require('../audit');
const { ValidationError, nonEmptyString } = require('../validation');
const {
  createGallery,
  galleryDetail,
  listResidencies,
  listSharedLightingRows,
} = require('../shared');

const router = express.Router();

router.use(require('../auth').requireAuth);

// 展厅列表（登录可读），附驻留与共享照明计数
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT g.*, u.display_name AS creator_name
         FROM galleries g
         LEFT JOIN users u ON u.id = g.created_by
        ORDER BY g.id`
    );
    const galleries = [];
    for (const g of rows) {
      const residencies = await listResidencies({ query }, { galleryId: Number(g.id) });
      const lightRows = await listSharedLightingRows({ query }, { galleryId: Number(g.id) });
      galleries.push({
        id: Number(g.id),
        code: g.code,
        name: g.name,
        note: g.note,
        createdBy: g.created_by != null ? Number(g.created_by) : null,
        creatorName: g.creator_name || null,
        createdAt: g.created_at,
        residencyCount: residencies.length,
        sharedLightingCount: lightRows.length,
      });
    }
    res.json({ galleries });
  } catch (err) {
    next(err);
  }
});

// 保管员登记展厅
router.post('/', requireRole('conservator'), async (req, res, next) => {
  try {
    const body = req.body || {};
    const code = nonEmptyString(body.code, '展厅标识', 50);
    const name = nonEmptyString(body.name, '展厅名称', 200);
    const note = typeof body.note === 'string' && body.note.trim() !== ''
      ? body.note.trim().slice(0, 1000) : null;

    const gallery = await require('../db').withTransaction(async (client) => {
      const row = await createGallery(client, { code, name, note }, req.sessionUser);
      await recordAudit(client, req.sessionUser, 'gallery.create', 'gallery', row.id, {
        code, name, note,
      });
      return row;
    });
    res.status(201).json({ gallery: { id: Number(gallery.id), code: gallery.code, name: gallery.name } });
  } catch (err) {
    next(err);
  }
});

// 展厅详情（:ref 优先按数字 id，其次按展厅标识 code）
router.get('/:ref', async (req, res, next) => {
  try {
    const ref = req.params.ref;
    if (!ref) throw new ValidationError('缺少展厅标识');
    let gallery = null;
    if (/^\d+$/.test(String(ref))) {
      gallery = (await query('SELECT * FROM galleries WHERE id = $1', [Number(ref)])).rows[0];
    }
    if (!gallery) {
      gallery = (await query('SELECT * FROM galleries WHERE code = $1', [String(ref)])).rows[0];
    }
    if (!gallery) throw new ValidationError(`展厅不存在：${ref}`);
    const detail = await galleryDetail({ query }, gallery);
    res.json({ gallery: detail });
  } catch (err) {
    next(err);
  }
});

module.exports = { router };
