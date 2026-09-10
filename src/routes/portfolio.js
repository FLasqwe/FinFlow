const express = require('express');
const { z } = require('zod');
const pool = require('../db/pool');
const requireAuth = require('../middleware/requireAuth');
const requirePro = require('../middleware/requirePro');

const router = express.Router();
router.use(requireAuth);
router.use(requirePro); // портфель — фича тарифа Pro

function toPublicHolding(row, lots) {
  return {
    id: row.id,
    type: row.type,
    assetId: row.asset_id,
    name: row.name,
    sym: row.sym,
    icon: row.icon,
    color: row.color,
    manualPrice: row.manual_price != null ? Number(row.manual_price) : null,
    manualPriceCur: row.manual_price_cur,
    manualPriceTs: row.manual_price_ts,
    lots: lots.map((l) => ({
      id: l.id,
      qty: Number(l.qty),
      price: Number(l.price),
      cur: l.currency,
      date: l.date, // строка 'YYYY-MM-DD' (types.setTypeParser в db/pool.js)
    })),
  };
}

// ── GET /api/portfolio — все холдинги с их лотами ─────────
router.get('/', async (req, res) => {
  const holdings = await pool.query('SELECT * FROM portfolio_holdings WHERE user_id=$1 ORDER BY created_at', [req.userId]);
  if (!holdings.rowCount) return res.json({ holdings: [] });

  const ids = holdings.rows.map((h) => h.id);
  const lots = await pool.query(
    'SELECT * FROM portfolio_lots WHERE holding_id = ANY($1) ORDER BY date',
    [ids]
  );
  const lotsByHolding = {};
  lots.rows.forEach((l) => {
    (lotsByHolding[l.holding_id] ||= []).push(l);
  });

  res.json({
    holdings: holdings.rows.map((h) => toPublicHolding(h, lotsByHolding[h.id] || [])),
  });
});

// ── POST /api/portfolio/holdings — добавить актив + первый лот
//     (или лот к уже существующему активу того же type+assetId) ──
const createSchema = z.object({
  type: z.enum(['crypto', 'metal', 'currency', 'stock']),
  assetId: z.string().min(1).max(20),
  name: z.string().min(1).max(80),
  sym: z.string().min(1).max(40),
  icon: z.string().max(16).optional(),
  color: z.string().max(16).optional(),
  lot: z.object({
    qty: z.number().positive(),
    price: z.number().nonnegative(),
    cur: z.string().length(3),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }),
});
router.post('/holdings', async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Некорректные данные', details: parsed.error.flatten() });
  const { type, assetId, name, sym, icon, color, lot } = parsed.data;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let holding = (
      await client.query('SELECT * FROM portfolio_holdings WHERE user_id=$1 AND type=$2 AND asset_id=$3', [req.userId, type, assetId])
    ).rows[0];

    if (!holding) {
      const isStock = type === 'stock';
      const manualPrice = isStock ? lot.price : null;
      const manualCur = isStock ? lot.cur : null;
      const manualTs = isStock ? new Date() : null;
      holding = (
        await client.query(
          `INSERT INTO portfolio_holdings (user_id, type, asset_id, name, sym, icon, color, manual_price, manual_price_cur, manual_price_ts)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           RETURNING *`,
          [req.userId, type, assetId, name, sym, icon || null, color || null, manualPrice, manualCur, manualTs]
        )
      ).rows[0];
    } else if (type === 'stock') {
      holding = (
        await client.query(
          `UPDATE portfolio_holdings SET manual_price=$1, manual_price_cur=$2, manual_price_ts=now() WHERE id=$3 RETURNING *`,
          [lot.price, lot.cur, holding.id]
        )
      ).rows[0];
    }

    await client.query(
      'INSERT INTO portfolio_lots (holding_id, qty, price, currency, date) VALUES ($1,$2,$3,$4,$5)',
      [holding.id, lot.qty, lot.price, lot.cur, lot.date]
    );
    await client.query('COMMIT');

    const lots = (await client.query('SELECT * FROM portfolio_lots WHERE holding_id=$1 ORDER BY date', [holding.id])).rows;
    res.status(201).json({ holding: toPublicHolding(holding, lots) });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// ── POST /api/portfolio/holdings/:id/lots — докупить (новый лот) ──
const lotSchema = z.object({
  qty: z.number().positive(),
  price: z.number().nonnegative(),
  cur: z.string().length(3),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
router.post('/holdings/:id/lots', async (req, res) => {
  const parsed = lotSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Некорректные данные' });

  const owns = await pool.query('SELECT id FROM portfolio_holdings WHERE id=$1 AND user_id=$2', [req.params.id, req.userId]);
  if (!owns.rowCount) return res.status(404).json({ error: 'Актив не найден' });

  const result = await pool.query(
    'INSERT INTO portfolio_lots (holding_id, qty, price, currency, date) VALUES ($1,$2,$3,$4,$5) RETURNING *',
    [req.params.id, parsed.data.qty, parsed.data.price, parsed.data.cur, parsed.data.date]
  );
  res.status(201).json({
    lot: {
      id: result.rows[0].id,
      qty: Number(result.rows[0].qty),
      price: Number(result.rows[0].price),
      cur: result.rows[0].currency,
      date: result.rows[0].date, // строка 'YYYY-MM-DD' (types.setTypeParser в db/pool.js)
    },
  });
});

// ── PATCH /api/portfolio/holdings/:id/price — ручное обновление цены (акции) ──
const priceSchema = z.object({ price: z.number().nonnegative(), cur: z.string().length(3) });
router.patch('/holdings/:id/price', async (req, res) => {
  const parsed = priceSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Некорректные данные' });

  const result = await pool.query(
    `UPDATE portfolio_holdings SET manual_price=$1, manual_price_cur=$2, manual_price_ts=now()
     WHERE id=$3 AND user_id=$4 RETURNING *`,
    [parsed.data.price, parsed.data.cur, req.params.id, req.userId]
  );
  if (!result.rowCount) return res.status(404).json({ error: 'Актив не найден' });
  res.json({ ok: true });
});

// ── DELETE /api/portfolio/lots/:id ────────────────────────
router.delete('/lots/:id', async (req, res) => {
  // Проверяем принадлежность лота пользователю через holding.user_id
  const result = await pool.query(
    `DELETE FROM portfolio_lots l USING portfolio_holdings h
     WHERE l.id=$1 AND l.holding_id=h.id AND h.user_id=$2
     RETURNING l.holding_id`,
    [req.params.id, req.userId]
  );
  if (!result.rowCount) return res.status(404).json({ error: 'Покупка не найдена' });

  // Если лотов больше не осталось — удаляем и сам холдинг
  const remaining = await pool.query('SELECT COUNT(*) FROM portfolio_lots WHERE holding_id=$1', [result.rows[0].holding_id]);
  if (parseInt(remaining.rows[0].count, 10) === 0) {
    await pool.query('DELETE FROM portfolio_holdings WHERE id=$1', [result.rows[0].holding_id]);
  }
  res.json({ ok: true });
});

// ── DELETE /api/portfolio/holdings/:id — удалить весь актив ──
router.delete('/holdings/:id', async (req, res) => {
  const result = await pool.query(
    'DELETE FROM portfolio_holdings WHERE id=$1 AND user_id=$2 RETURNING id',
    [req.params.id, req.userId]
  );
  if (!result.rowCount) return res.status(404).json({ error: 'Актив не найден' });
  res.json({ ok: true });
});

module.exports = router;
