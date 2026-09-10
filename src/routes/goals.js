const express = require('express');
const { z } = require('zod');
const pool = require('../db/pool');
const requireAuth = require('../middleware/requireAuth');
const requireTier = require('../middleware/requireTier');

const router = express.Router();
router.use(requireAuth);
router.use(requireTier('premium')); // цели — от тарифа Premium

const DAY = 86400000;

function toPublicGoal(row) {
  const target = Number(row.target);
  const saved = Number(row.saved);
  const pct = target > 0 ? Math.min(100, Math.round((saved / target) * 100)) : 0;
  const remaining = Math.max(0, target - saved);
  let perMonth = null;
  let daysLeft = null;
  if (row.deadline) {
    const dl = new Date(row.deadline + 'T00:00:00Z').getTime();
    daysLeft = Math.ceil((dl - Date.now()) / DAY);
    const months = Math.max(1, daysLeft / 30.44);
    perMonth = remaining > 0 && daysLeft > 0 ? Math.ceil(remaining / months) : 0;
  }
  return {
    id: row.id,
    name: row.name,
    target,
    saved,
    deadline: row.deadline,
    icon: row.icon,
    color: row.color,
    accountId: row.account_id,
    pct,
    remaining,
    perMonth,
    daysLeft,
    done: saved >= target,
  };
}

// ── GET /api/goals ──
router.get('/', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM goals WHERE user_id=$1 AND archived=false ORDER BY created_at DESC',
    [req.userId]
  );
  res.json({ goals: rows.map(toPublicGoal) });
});

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const createSchema = z.object({
  name: z.string().min(1).max(80),
  target: z.number().positive(),
  saved: z.number().nonnegative().optional(),
  deadline: z.string().regex(DATE_RE).nullable().optional(),
  icon: z.string().max(16).nullable().optional(),
  color: z.string().max(16).nullable().optional(),
  accountId: z.string().uuid().nullable().optional(),
});

// ── POST /api/goals ──
router.post('/', async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Некорректные данные', details: parsed.error.flatten() });
  const d = parsed.data;
  const { rows } = await pool.query(
    `INSERT INTO goals (user_id, name, target, saved, deadline, icon, color, account_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [req.userId, d.name, d.target, d.saved ?? 0, d.deadline ?? null, d.icon ?? null, d.color ?? null, d.accountId ?? null]
  );
  res.status(201).json({ goal: toPublicGoal(rows[0]) });
});

// ── PATCH /api/goals/:id ──
const patchSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  target: z.number().positive().optional(),
  deadline: z.string().regex(DATE_RE).nullable().optional(),
  icon: z.string().max(16).nullable().optional(),
  color: z.string().max(16).nullable().optional(),
  accountId: z.string().uuid().nullable().optional(),
  archived: z.boolean().optional(),
});
const COL = { name: 'name', target: 'target', deadline: 'deadline', icon: 'icon', color: 'color', accountId: 'account_id', archived: 'archived' };
router.patch('/:id', async (req, res) => {
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Некорректные данные' });
  const entries = Object.entries(parsed.data);
  if (!entries.length) return res.status(400).json({ error: 'Нечего обновлять' });
  const sets = entries.map(([f], i) => `${COL[f]} = $${i + 1}`);
  const values = entries.map(([, v]) => v);
  values.push(req.params.id, req.userId);
  const { rows } = await pool.query(
    `UPDATE goals SET ${sets.join(', ')} WHERE id=$${values.length - 1} AND user_id=$${values.length} RETURNING *`,
    values
  );
  if (!rows.length) return res.status(404).json({ error: 'Цель не найдена' });
  res.json({ goal: toPublicGoal(rows[0]) });
});

// ── POST /api/goals/:id/contribute — пополнить (amount может быть отрицательным) ──
const contribSchema = z.object({ amount: z.number() });
router.post('/:id/contribute', async (req, res) => {
  const parsed = contribSchema.safeParse(req.body);
  if (!parsed.success || parsed.data.amount === 0) return res.status(400).json({ error: 'Введи сумму' });
  const { rows } = await pool.query(
    'UPDATE goals SET saved = GREATEST(0, saved + $1) WHERE id=$2 AND user_id=$3 RETURNING *',
    [parsed.data.amount, req.params.id, req.userId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Цель не найдена' });
  res.json({ goal: toPublicGoal(rows[0]) });
});

// ── DELETE /api/goals/:id ──
router.delete('/:id', async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM goals WHERE id=$1 AND user_id=$2', [req.params.id, req.userId]);
  if (!rowCount) return res.status(404).json({ error: 'Цель не найдена' });
  res.json({ ok: true });
});

module.exports = router;
