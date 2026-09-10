const express = require('express');
const { z } = require('zod');
const pool = require('../db/pool');
const requireAuth = require('../middleware/requireAuth');
const { effectiveTier, walletLimit } = require('../plan');
const { logEvent } = require('../events');
const { CHAINS, CHAIN_IDS, validateAddress, fetchNativeBalance } = require('../chains');
const { priceOf } = require('../prices');

const router = express.Router();
router.use(requireAuth);

const SYNC_COOLDOWN_MS = 15_000; // не дёргать эксплорер чаще раза в 15 сек на кошелёк

function toPublic(row) {
  return {
    id: row.id,
    chain: row.chain,
    address: row.address,
    label: row.label || null,
    native: row.last_native != null ? Number(row.last_native) : null,
    usd: row.last_usd != null ? Number(row.last_usd) : null,
    price: row.last_price != null ? Number(row.last_price) : null,
    lastSync: row.last_sync,
    error: row.sync_error || null,
    sym: CHAINS[row.chain]?.sym || row.chain,
    name: CHAINS[row.chain]?.name || row.chain,
  };
}

// Тянет баланс и курс, пишет результат в строку. Мягко: ошибку кладёт в sync_error.
async function syncRow(row) {
  try {
    const native = await fetchNativeBalance(row.chain, row.address);
    const price = await priceOf(row.chain).catch(() => null);
    const usd = price != null ? native * price : null;
    const { rows } = await pool.query(
      `UPDATE wallets SET last_native=$1, last_price=$2, last_usd=$3, last_sync=now(), sync_error=NULL
       WHERE id=$4 RETURNING *`,
      [native, price, usd, row.id]
    );
    return rows[0];
  } catch (e) {
    const msg = (e && e.message) ? String(e.message).slice(0, 200) : 'Ошибка синхронизации';
    const { rows } = await pool.query(
      `UPDATE wallets SET last_sync=now(), sync_error=$1 WHERE id=$2 RETURNING *`,
      [msg, row.id]
    );
    return rows[0];
  }
}

function summarize(rows) {
  const wallets = rows.map(toPublic);
  const totalUsd = wallets.reduce((s, w) => s + (w.usd || 0), 0);
  const byChain = {};
  for (const w of wallets) {
    if (w.usd) byChain[w.chain] = (byChain[w.chain] || 0) + w.usd;
  }
  return { wallets, totalUsd, byChain };
}

// ── GET /api/wallets ──
router.get('/', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM wallets WHERE user_id=$1 ORDER BY created_at',
    [req.userId]
  );
  res.json(summarize(rows));
});

// ── POST /api/wallets { chain, address, label? } ──
const createSchema = z.object({
  chain: z.enum(CHAIN_IDS),
  address: z.string().min(1).max(120),
  label: z.string().max(40).optional(),
});
router.post('/', async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Некорректные данные' });
  const { chain, label } = parsed.data;

  const v = validateAddress(chain, parsed.data.address);
  if (!v.ok) return res.status(400).json({ error: v.error });

  const u = (await pool.query('SELECT tier, tier_until FROM users WHERE id=$1', [req.userId])).rows[0] || {};
  const limit = walletLimit(u);
  const count = Number(
    (await pool.query('SELECT count(*)::int AS n FROM wallets WHERE user_id=$1', [req.userId])).rows[0].n
  );
  if (count >= limit) {
    const tier = effectiveTier(u);
    return res.status(402).json({
      error: tier === 'free'
        ? 'На бесплатном тарифе можно добавить 2 кошелька. Pro — 10, Premium — без ограничений.'
        : 'На тарифе Pro можно добавить 10 кошельков. Premium снимает ограничение.',
      upgrade: true,
      need: tier === 'free' ? 'pro' : 'premium',
    });
  }

  let row;
  try {
    row = (await pool.query(
      `INSERT INTO wallets (user_id, chain, address, label) VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.userId, chain, v.address, label || null]
    )).rows[0];
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Такой адрес уже добавлен' });
    throw e;
  }

  row = await syncRow(row); // первая синхронизация сразу
  logEvent(req.userId, 'wallet_add', { chain });
  res.status(201).json({ wallet: toPublic(row) });
});

// ── POST /api/wallets/:id/sync ── обновить один ──
router.post('/:id/sync', async (req, res) => {
  const row = (await pool.query('SELECT * FROM wallets WHERE id=$1 AND user_id=$2', [req.params.id, req.userId])).rows[0];
  if (!row) return res.status(404).json({ error: 'Кошелёк не найден' });
  if (row.last_sync && Date.now() - new Date(row.last_sync).getTime() < SYNC_COOLDOWN_MS) {
    return res.json({ wallet: toPublic(row), skipped: true });
  }
  res.json({ wallet: toPublic(await syncRow(row)) });
});

// ── POST /api/wallets/sync ── обновить все (с учётом кулдауна) ──
router.post('/sync', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM wallets WHERE user_id=$1 ORDER BY created_at', [req.userId]);
  const out = [];
  for (const row of rows) {
    if (row.last_sync && Date.now() - new Date(row.last_sync).getTime() < SYNC_COOLDOWN_MS) {
      out.push(row);
    } else {
      out.push(await syncRow(row));
    }
  }
  res.json(summarize(out));
});

// ── PATCH /api/wallets/:id { label } ──
const patchSchema = z.object({ label: z.string().max(40).nullable().optional() });
router.patch('/:id', async (req, res) => {
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Некорректные данные' });
  const { rows } = await pool.query(
    'UPDATE wallets SET label=$1 WHERE id=$2 AND user_id=$3 RETURNING *',
    [parsed.data.label ?? null, req.params.id, req.userId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Кошелёк не найден' });
  res.json({ wallet: toPublic(rows[0]) });
});

// ── DELETE /api/wallets/:id ──
router.delete('/:id', async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM wallets WHERE id=$1 AND user_id=$2', [req.params.id, req.userId]);
  if (!rowCount) return res.status(404).json({ error: 'Кошелёк не найден' });
  res.json({ ok: true });
});

module.exports = router;
