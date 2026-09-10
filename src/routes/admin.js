const express = require('express');
const { z } = require('zod');
const pool = require('../db/pool');
const requireAuth = require('../middleware/requireAuth');
const { requireAdmin } = require('../middleware/requireAdmin');
const { effectiveTier, TIERS, LIFETIME } = require('../plan');
const { logEvent } = require('../events');

const router = express.Router();
router.use(requireAuth);
router.use(requireAdmin);

// ── GET /api/admin/overview ──
router.get('/overview', async (req, res) => {
  const [users, byTier, signups, totals, promos] = await Promise.all([
    pool.query(`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE created_at > now() - interval '7 days')::int  AS d7,
             count(*) FILTER (WHERE created_at > now() - interval '30 days')::int AS d30,
             count(*) FILTER (WHERE last_seen  > now() - interval '7 days')::int  AS active7
      FROM users`),
    pool.query('SELECT tier, tier_until FROM users'),
    pool.query(`
      SELECT to_char(day, 'YYYY-MM-DD') AS day, coalesce(n,0)::int AS n FROM (
        SELECT generate_series(current_date - interval '13 days', current_date, interval '1 day')::date AS day
      ) d
      LEFT JOIN (
        SELECT created_at::date AS day, count(*) AS n FROM users
        WHERE created_at > current_date - interval '14 days' GROUP BY 1
      ) s USING (day)
      ORDER BY day`),
    pool.query(`
      SELECT
        (SELECT count(*)::int FROM transactions)    AS transactions,
        (SELECT count(*)::int FROM accounts)         AS accounts,
        (SELECT count(*)::int FROM recurring_rules)  AS recurring,
        (SELECT count(*)::int FROM support_threads WHERE needs_human=true AND status<>'closed') AS support_waiting`),
    pool.query('SELECT code, kind, grants_tier, used_count, max_uses, active FROM promo_codes ORDER BY used_count DESC LIMIT 20'),
  ]);

  const tierCounts = { free: 0, pro: 0, premium: 0, business: 0 };
  byTier.rows.forEach((r) => { tierCounts[effectiveTier(r)] += 1; });

  res.json({
    users: users.rows[0],
    tiers: tierCounts,
    signups: signups.rows,
    totals: totals.rows[0],
    promos: promos.rows.map((p) => ({ ...p, used_count: Number(p.used_count) })),
  });
});

// ── GET /api/admin/users?q=&limit= ──
router.get('/users', async (req, res) => {
  const q = (req.query.q || '').trim().toLowerCase();
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  const params = [limit];
  let where = '';
  if (q) { params.push(`%${q}%`); where = 'WHERE lower(u.email) LIKE $2 OR lower(u.name) LIKE $2'; }

  const { rows } = await pool.query(
    `SELECT u.id, u.email, u.name, u.surname, u.tier, u.tier_until, u.tier_source,
            u.totp_enabled, u.created_at, u.last_seen,
            (SELECT count(*)::int FROM transactions t WHERE t.user_id=u.id) AS tx,
            (SELECT count(*)::int FROM accounts a WHERE a.user_id=u.id)     AS accounts
     FROM users u ${where}
     ORDER BY u.created_at DESC
     LIMIT $1`,
    params
  );
  res.json({ users: rows.map((u) => ({ ...u, effectiveTier: effectiveTier(u) })) });
});

// ── GET /api/admin/users/:id ──
router.get('/users/:id', async (req, res) => {
  const u = (await pool.query('SELECT * FROM users WHERE id=$1', [req.params.id])).rows[0];
  if (!u) return res.status(404).json({ error: 'Пользователь не найден' });
  const [tx, redemptions, ev] = await Promise.all([
    pool.query('SELECT type, amount, category, note, date, created_at FROM transactions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20', [req.params.id]),
    pool.query('SELECT code, created_at FROM promo_redemptions WHERE user_id=$1 ORDER BY created_at DESC', [req.params.id]),
    pool.query('SELECT type, meta, created_at FROM events WHERE user_id=$1 ORDER BY created_at DESC LIMIT 30', [req.params.id]),
  ]);
  res.json({
    user: {
      id: u.id, email: u.email, name: u.name, surname: u.surname, avatar: u.avatar,
      currency: u.currency, tier: u.tier, tier_until: u.tier_until, tier_source: u.tier_source,
      effectiveTier: effectiveTier(u), totp_enabled: u.totp_enabled,
      created_at: u.created_at, last_seen: u.last_seen, promo_discount: u.promo_discount,
    },
    transactions: tx.rows.map((t) => ({ ...t, amount: Number(t.amount) })),
    redemptions: redemptions.rows,
    events: ev.rows,
  });
});

// ── POST /api/admin/users/:id/tier ── выдать/сменить тариф вручную
const tierSchema = z.object({
  tier: z.enum(['free', 'pro', 'premium', 'business']),
  days: z.number().int().positive().optional(), // не задано + не free → навсегда
});
router.post('/users/:id/tier', async (req, res) => {
  const parsed = tierSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Некорректные данные' });
  const { tier, days } = parsed.data;

  let until = null;
  if (tier !== 'free') until = days ? `now() + interval '${days} days'` : `'${LIFETIME}'`;
  const { rows } = await pool.query(
    `UPDATE users SET tier=$1, tier_until=${tier === 'free' ? 'NULL' : until}, tier_source='admin'
     WHERE id=$2 RETURNING id, email, tier, tier_until`,
    [tier, req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Пользователь не найден' });
  logEvent(req.params.id, 'tier_change', { by: 'admin', tier, days: days || null });
  res.json({ ok: true, user: rows[0] });
});

// ── Поддержка ──────────────────────────────────────────────
router.get('/support', async (req, res) => {
  const { rows } = await pool.query(`
    SELECT t.id, t.status, t.needs_human, t.last_message_at, t.created_at, u.email,
           (SELECT count(*)::int FROM support_messages m WHERE m.thread_id=t.id) AS messages,
           (SELECT body FROM support_messages m WHERE m.thread_id=t.id ORDER BY created_at DESC LIMIT 1) AS last_body,
           (SELECT sender FROM support_messages m WHERE m.thread_id=t.id ORDER BY created_at DESC LIMIT 1) AS last_sender
    FROM support_threads t JOIN users u ON u.id=t.user_id
    WHERE t.status <> 'closed'
    ORDER BY (t.needs_human) DESC, t.last_message_at DESC
    LIMIT 100`);
  res.json({ threads: rows });
});

router.get('/support/:id', async (req, res) => {
  const t = (await pool.query(
    `SELECT t.*, u.email FROM support_threads t JOIN users u ON u.id=t.user_id WHERE t.id=$1`,
    [req.params.id]
  )).rows[0];
  if (!t) return res.status(404).json({ error: 'Тред не найден' });
  const messages = (await pool.query(
    'SELECT id, sender, body, created_at FROM support_messages WHERE thread_id=$1 ORDER BY created_at',
    [req.params.id]
  )).rows;
  res.json({ thread: { id: t.id, email: t.email, status: t.status, needs_human: t.needs_human }, messages });
});

const replySchema = z.object({ body: z.string().min(1).max(4000) });
router.post('/support/:id/reply', async (req, res) => {
  const parsed = replySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Пустой или слишком длинный ответ' });
  const own = await pool.query('SELECT id FROM support_threads WHERE id=$1', [req.params.id]);
  if (!own.rowCount) return res.status(404).json({ error: 'Тред не найден' });
  await pool.query("INSERT INTO support_messages (thread_id, sender, body) VALUES ($1,'admin',$2)", [req.params.id, parsed.data.body]);
  await pool.query("UPDATE support_threads SET status='answered', needs_human=false, last_message_at=now() WHERE id=$1", [req.params.id]);
  res.json({ ok: true });
});

router.post('/support/:id/close', async (req, res) => {
  const { rowCount } = await pool.query("UPDATE support_threads SET status='closed' WHERE id=$1", [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: 'Тред не найден' });
  res.json({ ok: true });
});

// ── GET /api/admin/events?limit= ──
router.get('/events', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 300);
  const { rows } = await pool.query(
    `SELECT e.type, e.meta, e.created_at, u.email
     FROM events e LEFT JOIN users u ON u.id = e.user_id
     ORDER BY e.created_at DESC LIMIT $1`,
    [limit]
  );
  res.json({ events: rows });
});

module.exports = router;
