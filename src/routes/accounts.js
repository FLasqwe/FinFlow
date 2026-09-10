const express = require('express');
const { z } = require('zod');
const pool = require('../db/pool');
const requireAuth = require('../middleware/requireAuth');
const { accountLimit, effectiveTier } = require('../plan');

const router = express.Router();
router.use(requireAuth);

function toPublicAccount(row) {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    currency: row.currency,
    startBalance: Number(row.start_balance),
    icon: row.icon,
    color: row.color,
    archived: row.archived,
    sort: row.sort,
  };
}

async function listAccounts(userId) {
  const { rows } = await pool.query(
    'SELECT * FROM accounts WHERE user_id=$1 ORDER BY sort, created_at',
    [userId]
  );
  return rows;
}

// ── GET /api/accounts ──
// Если счетов нет — создаём дефолтный и подхватываем к нему все непривязанные транзакции.
router.get('/', async (req, res) => {
  let rows = await listAccounts(req.userId);
  if (!rows.length) {
    const u = (await pool.query('SELECT currency FROM users WHERE id=$1', [req.userId])).rows[0];
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const acc = (await client.query(
        `INSERT INTO accounts (user_id, name, kind, currency) VALUES ($1,'Основной','cash',$2) RETURNING *`,
        [req.userId, u?.currency || 'RUB']
      )).rows[0];
      await client.query(
        'UPDATE transactions SET account_id=$1 WHERE user_id=$2 AND account_id IS NULL',
        [acc.id, req.userId]
      );
      await client.query('COMMIT');
      rows = [acc];
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
  res.json({ accounts: rows.map(toPublicAccount) });
});

// ── POST /api/accounts ──
const createSchema = z.object({
  name: z.string().min(1).max(60),
  kind: z.enum(['card', 'cash', 'bank', 'savings', 'crypto', 'other']),
  currency: z.string().length(3),
  startBalance: z.number().optional(),
  icon: z.string().max(16).optional(),
  color: z.string().max(16).optional(),
});
router.post('/', async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Некорректные данные', details: parsed.error.flatten() });

  const u = (await pool.query('SELECT tier, tier_until FROM users WHERE id=$1', [req.userId])).rows[0] || {};
  const limit = accountLimit(u);
  const count = Number(
    (await pool.query('SELECT count(*)::int AS n FROM accounts WHERE user_id=$1 AND archived=false', [req.userId])).rows[0].n
  );
  if (count >= limit) {
    const tier = effectiveTier(u);
    return res.status(402).json({
      error: tier === 'free'
        ? 'На бесплатном тарифе доступен 1 счёт. Оформи Pro — до 5 счетов, Premium — без ограничений.'
        : 'На тарифе Pro доступно 5 счетов. Premium снимает ограничение.',
      upgrade: true,
      need: tier === 'free' ? 'pro' : 'premium',
    });
  }

  const d = parsed.data;
  const { rows } = await pool.query(
    `INSERT INTO accounts (user_id, name, kind, currency, start_balance, icon, color, sort)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [req.userId, d.name, d.kind, d.currency.toUpperCase(), d.startBalance ?? 0, d.icon || null, d.color || null, count]
  );
  res.status(201).json({ account: toPublicAccount(rows[0]) });
});

// ── PATCH /api/accounts/:id ──
const patchSchema = z.object({
  name: z.string().min(1).max(60).optional(),
  kind: z.enum(['card', 'cash', 'bank', 'savings', 'crypto', 'other']).optional(),
  currency: z.string().length(3).optional(),
  startBalance: z.number().optional(),
  icon: z.string().max(16).nullable().optional(),
  color: z.string().max(16).nullable().optional(),
  archived: z.boolean().optional(),
  sort: z.number().int().optional(),
});
const COL = {
  name: 'name', kind: 'kind', currency: 'currency', startBalance: 'start_balance',
  icon: 'icon', color: 'color', archived: 'archived', sort: 'sort',
};
router.patch('/:id', async (req, res) => {
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Некорректные данные' });
  const entries = Object.entries(parsed.data);
  if (!entries.length) return res.status(400).json({ error: 'Нечего обновлять' });

  const sets = entries.map(([f], i) => `${COL[f]} = $${i + 1}`);
  const values = entries.map(([f, v]) => (f === 'currency' && typeof v === 'string' ? v.toUpperCase() : v));
  values.push(req.params.id, req.userId);
  const { rows } = await pool.query(
    `UPDATE accounts SET ${sets.join(', ')} WHERE id=$${values.length - 1} AND user_id=$${values.length} RETURNING *`,
    values
  );
  if (!rows.length) return res.status(404).json({ error: 'Счёт не найден' });
  res.json({ account: toPublicAccount(rows[0]) });
});

// ── DELETE /api/accounts/:id ──
// Нельзя удалить последний счёт. Транзакции удаляемого переносятся на старейший из оставшихся.
router.delete('/:id', async (req, res) => {
  const all = await listAccounts(req.userId);
  if (all.length <= 1) return res.status(409).json({ error: 'Нельзя удалить единственный счёт' });
  if (!all.some((a) => a.id === req.params.id)) return res.status(404).json({ error: 'Счёт не найден' });
  const fallback = all.find((a) => a.id !== req.params.id);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE transactions SET account_id=$1 WHERE account_id=$2 AND user_id=$3', [fallback.id, req.params.id, req.userId]);
    await client.query('UPDATE recurring_rules SET account_id=$1 WHERE account_id=$2 AND user_id=$3', [fallback.id, req.params.id, req.userId]);
    await client.query('DELETE FROM accounts WHERE id=$1 AND user_id=$2', [req.params.id, req.userId]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  res.json({ ok: true, movedTo: fallback.id });
});

module.exports = router;
