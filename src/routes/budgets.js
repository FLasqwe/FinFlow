const express = require('express');
const { z } = require('zod');
const pool = require('../db/pool');
const requireAuth = require('../middleware/requireAuth');

const router = express.Router();
router.use(requireAuth);

// ── GET /api/budgets — вернуть как {category: amount} ────
router.get('/', async (req, res) => {
  const result = await pool.query('SELECT category, amount FROM budgets WHERE user_id=$1', [req.userId]);
  const budgets = {};
  result.rows.forEach((r) => { budgets[r.category] = Number(r.amount); });
  res.json({ budgets });
});

// ── PUT /api/budgets — полностью заменить набор бюджетов ──
const putSchema = z.record(z.string(), z.number().positive());
router.put('/', async (req, res) => {
  const parsed = putSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Некорректные данные' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM budgets WHERE user_id=$1', [req.userId]);
    const entries = Object.entries(parsed.data);
    for (const [category, amount] of entries) {
      await client.query(
        'INSERT INTO budgets (user_id, category, amount) VALUES ($1,$2,$3)',
        [req.userId, category, amount]
      );
    }
    await client.query('COMMIT');
    res.json({ budgets: parsed.data });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

module.exports = router;
