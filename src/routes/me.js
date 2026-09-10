const express = require('express');
const { z } = require('zod');
const QRCode = require('qrcode');
const pool = require('../db/pool');
const requireAuth = require('../middleware/requireAuth');
const { generateTotpSecret, totpKeyUri, verifyTotp } = require('../auth');
const { toPublicUser } = require('./auth');

const router = express.Router();
router.use(requireAuth);

// ── GET /api/me ────────────────────────────────────────────
router.get('/', async (req, res) => {
  const result = await pool.query('SELECT * FROM users WHERE id=$1', [req.userId]);
  if (!result.rowCount) return res.status(404).json({ error: 'Пользователь не найден' });
  res.json({ user: toPublicUser(result.rows[0]) });
});

// ── PATCH /api/me — обновление профиля/настроек ─────────────
const patchSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  surname: z.string().max(80).nullable().optional(),
  avatar: z.string().max(16).nullable().optional(),
  photoUrl: z.string().url().nullable().optional(),
  currency: z.string().length(3).optional(),
  theme: z.enum(['dark', 'light']).optional(),
  accentHue: z.number().int().min(0).max(360).optional(),
  dashboardWidgets: z.array(z.object({ id: z.string(), visible: z.boolean() })).optional(),
  watchlist: z.array(z.string().max(20)).max(50).optional(),
  nwAlertPct: z.number().min(0).max(90).optional(),
});
const FIELD_TO_COLUMN = {
  name: 'name',
  surname: 'surname',
  avatar: 'avatar',
  photoUrl: 'photo_url',
  currency: 'currency',
  theme: 'theme',
  accentHue: 'accent_hue',
  dashboardWidgets: 'dashboard_widgets',
  watchlist: 'watchlist',
  nwAlertPct: 'nw_alert_pct',
};
const JSON_FIELDS = new Set(['dashboardWidgets', 'watchlist']);
router.patch('/', async (req, res) => {
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Некорректные данные', details: parsed.error.flatten() });
  const entries = Object.entries(parsed.data);
  if (!entries.length) return res.status(400).json({ error: 'Нечего обновлять' });

  const sets = [];
  const values = [];
  entries.forEach(([field, value], i) => {
    const column = FIELD_TO_COLUMN[field];
    sets.push(`${column} = $${i + 1}`);
    values.push(JSON_FIELDS.has(field) ? JSON.stringify(value) : value);
  });
  values.push(req.userId);

  const result = await pool.query(
    `UPDATE users SET ${sets.join(', ')} WHERE id = $${values.length} RETURNING *`,
    values
  );
  res.json({ user: toPublicUser(result.rows[0]) });
});

// ── POST /api/me/password — смена пароля ────────────────────
const { verifyPassword, hashPassword } = require('../auth');
const passwordSchema = z.object({ oldPassword: z.string().min(1), newPassword: z.string().min(6) });
router.post('/password', async (req, res) => {
  const parsed = passwordSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Некорректные данные' });

  const result = await pool.query('SELECT password_hash FROM users WHERE id=$1', [req.userId]);
  if (!(await verifyPassword(parsed.data.oldPassword, result.rows[0].password_hash))) {
    return res.status(401).json({ error: 'Неверный текущий пароль' });
  }
  const newHash = await hashPassword(parsed.data.newPassword);
  await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [newHash, req.userId]);
  res.json({ ok: true });
});

// ── POST /api/me/2fa/setup — сгенерировать секрет + QR-код ──
router.post('/2fa/setup', async (req, res) => {
  const result = await pool.query('SELECT email FROM users WHERE id=$1', [req.userId]);
  const secret = generateTotpSecret();
  // Секрет сохраняем сразу, но totp_enabled остаётся false, пока не подтверждён кодом (/enable).
  await pool.query('UPDATE users SET totp_secret=$1 WHERE id=$2', [secret, req.userId]);
  const otpauthUrl = totpKeyUri(result.rows[0].email, secret);
  const qrDataUrl = await QRCode.toDataURL(otpauthUrl);
  res.json({ secret, otpauthUrl, qrDataUrl });
});

// ── POST /api/me/2fa/enable — подтвердить код и включить 2FA ──
const codeSchema = z.object({ code: z.string().length(6) });
router.post('/2fa/enable', async (req, res) => {
  const parsed = codeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Введи 6-значный код' });

  const result = await pool.query('SELECT totp_secret FROM users WHERE id=$1', [req.userId]);
  const secret = result.rows[0]?.totp_secret;
  if (!secret) return res.status(400).json({ error: 'Сначала вызови /2fa/setup' });
  if (!verifyTotp(parsed.data.code, secret)) return res.status(401).json({ error: 'Неверный код' });

  await pool.query('UPDATE users SET totp_enabled=true WHERE id=$1', [req.userId]);
  require('../events').logEvent(req.userId, '2fa_enable');
  res.json({ ok: true });
});

// ── POST /api/me/2fa/disable ─────────────────────────────────
router.post('/2fa/disable', async (req, res) => {
  const parsed = codeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Введи 6-значный код' });

  const result = await pool.query('SELECT totp_secret FROM users WHERE id=$1', [req.userId]);
  if (!verifyTotp(parsed.data.code, result.rows[0]?.totp_secret || '')) {
    return res.status(401).json({ error: 'Неверный код' });
  }
  await pool.query('UPDATE users SET totp_enabled=false, totp_secret=NULL WHERE id=$1', [req.userId]);
  res.json({ ok: true });
});

module.exports = router;
