const express = require('express');
const { z } = require('zod');
const pool = require('../db/pool');
const requireAuth = require('../middleware/requireAuth');
const { COINS, SYMS, getPrices, priceOf } = require('../prices');

const router = express.Router();
router.use(requireAuth);

const START_CASH = 10000;

async function ensureAccount(userId) {
  let a = (await pool.query('SELECT * FROM sim_accounts WHERE user_id=$1', [userId])).rows[0];
  if (!a) {
    a = (await pool.query(
      'INSERT INTO sim_accounts (user_id, cash, start_cash) VALUES ($1,$2,$2) RETURNING *',
      [userId, START_CASH]
    )).rows[0];
  }
  return a;
}

async function snapshot(userId) {
  const acc = await ensureAccount(userId);
  const [posRows, tradeRows, prices] = await Promise.all([
    pool.query('SELECT * FROM sim_positions WHERE user_id=$1 ORDER BY coin', [userId]),
    pool.query('SELECT * FROM sim_trades WHERE user_id=$1 ORDER BY created_at DESC LIMIT 25', [userId]),
    getPrices().catch(() => ({})),
  ]);
  const positions = posRows.rows.map((p) => {
    const qty = Number(p.qty), avg = Number(p.avg_price);
    const price = prices[p.coin] || avg;
    const value = qty * price;
    const cost = qty * avg;
    return {
      coin: p.coin, name: COINS[p.coin]?.name || p.coin,
      qty, avgPrice: avg, price,
      value, cost, pnl: value - cost, pnlPct: cost > 0 ? ((value - cost) / cost) * 100 : 0,
    };
  });
  const cash = Number(acc.cash);
  const startCash = Number(acc.start_cash);
  const posValue = positions.reduce((s, p) => s + p.value, 0);
  const totalValue = cash + posValue;
  const closed = tradeRows.rows.filter((t) => t.side === 'sell' && t.pnl != null);
  const wins = closed.filter((t) => Number(t.pnl) > 0).length;
  return {
    cash, startCash, positions,
    posValue, totalValue,
    totalPnl: totalValue - startCash,
    totalPnlPct: startCash > 0 ? ((totalValue - startCash) / startCash) * 100 : 0,
    stats: { trades: tradeRows.rows.length, closed: closed.length, wins, winRate: closed.length ? Math.round((wins / closed.length) * 100) : 0 },
    trades: tradeRows.rows.map((t) => ({
      coin: t.coin, side: t.side, qty: Number(t.qty), price: Number(t.price),
      usd: Number(t.usd), pnl: t.pnl != null ? Number(t.pnl) : null, createdAt: t.created_at,
    })),
    resetAt: acc.reset_at,
  };
}

// ── GET /api/sim ──
router.get('/', async (req, res) => {
  res.json(await snapshot(req.userId));
});

// ── POST /api/sim/buy { coin, usd } ──
const buySchema = z.object({ coin: z.enum(SYMS), usd: z.number().positive() });
router.post('/buy', async (req, res) => {
  const parsed = buySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Некорректные данные' });
  const { coin, usd } = parsed.data;
  const price = await priceOf(coin).catch(() => null);
  if (!price) return res.status(502).json({ error: 'Нет котировки, попробуйте позже' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const acc = (await client.query('SELECT * FROM sim_accounts WHERE user_id=$1 FOR UPDATE', [req.userId])).rows[0]
      || (await client.query('INSERT INTO sim_accounts (user_id, cash, start_cash) VALUES ($1,$2,$2) RETURNING *', [req.userId, START_CASH])).rows[0];
    if (Number(acc.cash) < usd) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Недостаточно виртуальных средств' }); }

    const qty = usd / price;
    const pos = (await client.query('SELECT * FROM sim_positions WHERE user_id=$1 AND coin=$2 FOR UPDATE', [req.userId, coin])).rows[0];
    if (pos) {
      const newQty = Number(pos.qty) + qty;
      const newAvg = (Number(pos.qty) * Number(pos.avg_price) + usd) / newQty;
      await client.query('UPDATE sim_positions SET qty=$1, avg_price=$2 WHERE user_id=$3 AND coin=$4', [newQty, newAvg, req.userId, coin]);
    } else {
      await client.query('INSERT INTO sim_positions (user_id, coin, qty, avg_price) VALUES ($1,$2,$3,$4)', [req.userId, coin, qty, price]);
    }
    await client.query('UPDATE sim_accounts SET cash = cash - $1 WHERE user_id=$2', [usd, req.userId]);
    await client.query(
      "INSERT INTO sim_trades (user_id, coin, side, qty, price, usd) VALUES ($1,$2,'buy',$3,$4,$5)",
      [req.userId, coin, qty, price, usd]
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  res.json(await snapshot(req.userId));
});

// ── POST /api/sim/sell { coin, qty? | all? } ──
const sellSchema = z.object({ coin: z.enum(SYMS), qty: z.number().positive().optional(), all: z.boolean().optional() });
router.post('/sell', async (req, res) => {
  const parsed = sellSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Некорректные данные' });
  const { coin } = parsed.data;
  const price = await priceOf(coin).catch(() => null);
  if (!price) return res.status(502).json({ error: 'Нет котировки, попробуйте позже' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const pos = (await client.query('SELECT * FROM sim_positions WHERE user_id=$1 AND coin=$2 FOR UPDATE', [req.userId, coin])).rows[0];
    if (!pos) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Нет такой позиции' }); }
    const held = Number(pos.qty);
    let qty = parsed.data.all ? held : (parsed.data.qty || 0);
    if (qty <= 0 || qty > held + 1e-9) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Некорректное количество' }); }
    if (qty > held) qty = held;

    const proceeds = qty * price;
    const pnl = qty * (price - Number(pos.avg_price));
    const left = held - qty;
    if (left <= 1e-10) {
      await client.query('DELETE FROM sim_positions WHERE user_id=$1 AND coin=$2', [req.userId, coin]);
    } else {
      await client.query('UPDATE sim_positions SET qty=$1 WHERE user_id=$2 AND coin=$3', [left, req.userId, coin]);
    }
    await client.query('UPDATE sim_accounts SET cash = cash + $1 WHERE user_id=$2', [proceeds, req.userId]);
    await client.query(
      "INSERT INTO sim_trades (user_id, coin, side, qty, price, usd, pnl) VALUES ($1,$2,'sell',$3,$4,$5,$6)",
      [req.userId, coin, qty, price, proceeds, pnl]
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  res.json(await snapshot(req.userId));
});

// ── POST /api/sim/reset ──
router.post('/reset', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM sim_positions WHERE user_id=$1', [req.userId]);
    await client.query('DELETE FROM sim_trades WHERE user_id=$1', [req.userId]);
    await client.query(
      `INSERT INTO sim_accounts (user_id, cash, start_cash, reset_at) VALUES ($1,$2,$2, now())
       ON CONFLICT (user_id) DO UPDATE SET cash=$2, reset_at=now()`,
      [req.userId, START_CASH]
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  res.json(await snapshot(req.userId));
});

module.exports = router;
