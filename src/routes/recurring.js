const express = require('express');
const { z } = require('zod');
const pool = require('../db/pool');
const requireAuth = require('../middleware/requireAuth');
const { nextDate } = require('../recurring');

const router = express.Router();
router.use(requireAuth);

function toPublicRule(row) {
  return {
    id: row.id,
    type: row.type,
    amount: Number(row.amount),
    category: row.category,
    note: row.note,
    cadence: row.cadence,
    dayOfMonth: row.day_of_month,
    dayOfWeek: row.day_of_week,
    monthOfYear: row.month_of_year,
    startDate: row.start_date,
    endDate: row.end_date,
    active: row.active,
    nextDate: row.active ? nextDate(row) : null,
  };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const baseFields = {
  type: z.enum(['income', 'expense']),
  amount: z.number().positive(),
  category: z.string().min(1).max(40),
  note: z.string().max(200).nullable().optional(),
  cadence: z.enum(['weekly', 'monthly', 'yearly']),
  dayOfMonth: z.number().int().min(1).max(31).nullable().optional(),
  dayOfWeek: z.number().int().min(0).max(6).nullable().optional(),
  monthOfYear: z.number().int().min(1).max(12).nullable().optional(),
  startDate: z.string().regex(DATE_RE),
  endDate: z.string().regex(DATE_RE).nullable().optional(),
  active: z.boolean().optional(),
};

function requireCadenceFields(data, ctx) {
  if (data.cadence === 'weekly' && data.dayOfWeek == null) {
    ctx.addIssue({ code: 'custom', message: 'Для «раз в неделю» нужен день недели', path: ['dayOfWeek'] });
  }
  if ((data.cadence === 'monthly' || data.cadence === 'yearly') && data.dayOfMonth == null) {
    ctx.addIssue({ code: 'custom', message: 'Нужен день месяца', path: ['dayOfMonth'] });
  }
  if (data.cadence === 'yearly' && data.monthOfYear == null) {
    ctx.addIssue({ code: 'custom', message: 'Для «раз в год» нужен месяц', path: ['monthOfYear'] });
  }
}

const createSchema = z.object(baseFields).superRefine(requireCadenceFields);

// ── GET /api/recurring ──
router.get('/', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM recurring_rules WHERE user_id=$1 ORDER BY created_at DESC',
    [req.userId]
  );
  res.json({ rules: rows.map(toPublicRule) });
});

// ── POST /api/recurring ──
router.post('/', async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Некорректные данные', details: parsed.error.flatten() });
  const d = parsed.data;
  const { rows } = await pool.query(
    `INSERT INTO recurring_rules
       (user_id, type, amount, category, note, cadence, day_of_month, day_of_week, month_of_year, start_date, end_date, active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING *`,
    [
      req.userId, d.type, d.amount, d.category, d.note || null, d.cadence,
      d.dayOfMonth ?? null, d.dayOfWeek ?? null, d.monthOfYear ?? null,
      d.startDate, d.endDate ?? null, d.active ?? true,
    ]
  );
  res.status(201).json({ rule: toPublicRule(rows[0]) });
});

// ── PATCH /api/recurring/:id ──
const patchSchema = z.object({
  ...Object.fromEntries(Object.entries(baseFields).map(([k, v]) => [k, v.optional()])),
}).superRefine((data, ctx) => {
  if (data.cadence) requireCadenceFields(data, ctx);
});
const FIELD_TO_COLUMN = {
  type: 'type', amount: 'amount', category: 'category', note: 'note', cadence: 'cadence',
  dayOfMonth: 'day_of_month', dayOfWeek: 'day_of_week', monthOfYear: 'month_of_year',
  startDate: 'start_date', endDate: 'end_date', active: 'active',
};
router.patch('/:id', async (req, res) => {
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Некорректные данные', details: parsed.error.flatten() });
  const entries = Object.entries(parsed.data);
  if (!entries.length) return res.status(400).json({ error: 'Нечего обновлять' });

  const sets = entries.map(([f], i) => `${FIELD_TO_COLUMN[f]} = $${i + 1}`);
  const values = entries.map(([, v]) => v);
  values.push(req.params.id, req.userId);

  const { rows } = await pool.query(
    `UPDATE recurring_rules SET ${sets.join(', ')}
     WHERE id = $${values.length - 1} AND user_id = $${values.length}
     RETURNING *`,
    values
  );
  if (!rows.length) return res.status(404).json({ error: 'Правило не найдено' });
  res.json({ rule: toPublicRule(rows[0]) });
});

// ── DELETE /api/recurring/:id ──
router.delete('/:id', async (req, res) => {
  const { rowCount } = await pool.query(
    'DELETE FROM recurring_rules WHERE id=$1 AND user_id=$2',
    [req.params.id, req.userId]
  );
  if (!rowCount) return res.status(404).json({ error: 'Правило не найдено' });
  res.json({ ok: true });
});

module.exports = router;
