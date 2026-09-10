const express = require('express');
const { z } = require('zod');
const pool = require('../db/pool');
const requireAuth = require('../middleware/requireAuth');
const { logEvent } = require('../events');

const router = express.Router();
router.use(requireAuth);

const CLASSES = ['cash', 'crypto', 'stocks', 'metals', 'realestate', 'business', 'other'];

function toPublic(row) {
  return {
    id: row.id,
    name: row.name,
    class: row.class,
    value: Number(row.value),
    currency: row.currency,
    note: row.note || null,
    icon: row.icon || null,
    archived: row.archived,
    sort: row.sort,
    updatedAt: row.updated_at,
  };
}

// ── GET /api/assets ──
router.get('/', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM assets WHERE user_id=$1 ORDER BY sort, created_at',
    [req.userId]
  );
  res.json({ assets: rows.map(toPublic) });
});

// ── POST /api/assets ──
const createSchema = z.object({
  name: z.string().min(1).max(80),
  class: z.enum(CLASSES),
  value: z.number(),
  currency: z.string().length(3).optional(),
  note: z.string().max(200).optional(),
  icon: z.string().max(16).optional(),
});
router.post('/', async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Некорректные данные' });
  const d = parsed.data;
  const n = Number(
    (await pool.query('SELECT count(*)::int AS n FROM assets WHERE user_id=$1', [req.userId])).rows[0].n
  );
  const { rows } = await pool.query(
    `INSERT INTO assets (user_id, name, class, value, currency, note, icon, sort)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [req.userId, d.name, d.class, d.value, (d.currency || 'USD').toUpperCase(), d.note || null, d.icon || null, n]
  );
  logEvent(req.userId, 'asset_create', { class: d.class });
  res.status(201).json({ asset: toPublic(rows[0]) });
});

// ── PATCH /api/assets/:id ──
const patchSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  class: z.enum(CLASSES).optional(),
  value: z.number().optional(),
  currency: z.string().length(3).optional(),
  note: z.string().max(200).nullable().optional(),
  icon: z.string().max(16).nullable().optional(),
  archived: z.boolean().optional(),
  sort: z.number().int().optional(),
});
const COL = {
  name: 'name', class: 'class', value: 'value', currency: 'currency',
  note: 'note', icon: 'icon', archived: 'archived', sort: 'sort',
};
router.patch('/:id', async (req, res) => {
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Некорректные данные' });
  const entries = Object.entries(parsed.data);
  if (!entries.length) return res.status(400).json({ error: 'Нечего обновлять' });

  const sets = entries.map(([f], i) => `${COL[f]} = $${i + 1}`);
  sets.push('updated_at = now()');
  const values = entries.map(([f, v]) => (f === 'currency' && typeof v === 'string' ? v.toUpperCase() : v));
  values.push(req.params.id, req.userId);
  const { rows } = await pool.query(
    `UPDATE assets SET ${sets.join(', ')} WHERE id=$${values.length - 1} AND user_id=$${values.length} RETURNING *`,
    values
  );
  if (!rows.length) return res.status(404).json({ error: 'Актив не найден' });
  res.json({ asset: toPublic(rows[0]) });
});

// ── DELETE /api/assets/:id ──
router.delete('/:id', async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM assets WHERE id=$1 AND user_id=$2', [req.params.id, req.userId]);
  if (!rowCount) return res.status(404).json({ error: 'Актив не найден' });
  res.json({ ok: true });
});

module.exports = router;
