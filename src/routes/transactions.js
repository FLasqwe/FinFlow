const express = require('express');
const { z } = require('zod');
const pool = require('../db/pool');
const requireAuth = require('../middleware/requireAuth');
const { runRecurringForUser } = require('../recurring');
const { isPro, FREE_TX_PER_MONTH } = require('../plan');

const router = express.Router();
router.use(requireAuth);

function toPublicTx(row) {
  return {
    id: row.id,
    type: row.type,
    amount: Number(row.amount),
    category: row.category,
    note: row.note,
    date: row.date, // строка 'YYYY-MM-DD' (см. types.setTypeParser в db/pool.js)
    recurringId: row.recurring_id || null,
  };
}

// ── GET /api/transactions ────────────────────────────────
// Без параметров — вся история. ?year=2026&month=9 — только один месяц (month: 1-12).
router.get('/', async (req, res) => {
  // Догоняем регулярные правила: создаём набежавшие транзакции до сегодня.
  try {
    await runRecurringForUser(req.userId);
  } catch (err) {
    console.error('recurring materialization failed:', err.message);
    // не роняем список транзакций из-за регулярок
  }

  const { year, month } = req.query;
  let result;
  if (year && month) {
    const y = parseInt(year, 10), m = parseInt(month, 10);
    result = await pool.query(
      `SELECT * FROM transactions
       WHERE user_id=$1 AND date >= make_date($2,$3,1) AND date < (make_date($2,$3,1) + interval '1 month')
       ORDER BY date DESC, created_at DESC`,
      [req.userId, y, m]
    );
  } else {
    result = await pool.query(
      'SELECT * FROM transactions WHERE user_id=$1 ORDER BY date DESC, created_at DESC',
      [req.userId]
    );
  }
  res.json({ transactions: result.rows.map(toPublicTx) });
});

// ── POST /api/transactions ───────────────────────────────
const createSchema = z.object({
  type: z.enum(['income', 'expense']),
  amount: z.number().positive(),
  category: z.string().min(1).max(40),
  note: z.string().max(200).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
router.post('/', async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Некорректные данные', details: parsed.error.flatten() });
  const { type, amount, category, note, date } = parsed.data;

  // Лимит free-тарифа: не больше FREE_TX_PER_MONTH ручных транзакций за календарный месяц.
  // Авто-транзакции из регулярных правил идут мимо этого маршрута и не считаются.
  const { rows: u } = await pool.query('SELECT pro_until FROM users WHERE id=$1', [req.userId]);
  if (!isPro(u[0] || {})) {
    const { rows: cnt } = await pool.query(
      `SELECT count(*)::int AS n FROM transactions
       WHERE user_id=$1 AND date >= date_trunc('month', CURRENT_DATE)`,
      [req.userId]
    );
    if (cnt[0].n >= FREE_TX_PER_MONTH) {
      return res.status(402).json({
        error: `Лимит бесплатного тарифа — ${FREE_TX_PER_MONTH} транзакций в месяц. Оформи Pro, чтобы снять ограничение.`,
        upgrade: true,
      });
    }
  }

  const result = await pool.query(
    `INSERT INTO transactions (user_id, type, amount, category, note, date)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [req.userId, type, amount, category, note || null, date]
  );
  res.status(201).json({ transaction: toPublicTx(result.rows[0]) });
});

// ── DELETE /api/transactions/:id ──────────────────────────
router.delete('/:id', async (req, res) => {
  const result = await pool.query(
    'DELETE FROM transactions WHERE id=$1 AND user_id=$2 RETURNING id',
    [req.params.id, req.userId]
  );
  if (!result.rowCount) return res.status(404).json({ error: 'Транзакция не найдена' });
  res.json({ ok: true });
});

// ── DELETE /api/transactions — удалить всю историю («Опасная зона») ──
router.delete('/', async (req, res) => {
  await pool.query('DELETE FROM transactions WHERE user_id=$1', [req.userId]);
  res.json({ ok: true });
});

module.exports = router;
