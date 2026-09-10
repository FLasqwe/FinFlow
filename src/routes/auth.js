const express = require('express');
const { z } = require('zod');
const pool = require('../db/pool');
const {
  hashPassword,
  verifyPassword,
  signAccessToken,
  signTempToken,
  verifyTempToken,
  generateRefreshToken,
  hashRefreshToken,
  refreshExpiryDate,
  verifyTotp,
} = require('../auth');
const { logEvent } = require('../events');
const { sendVerifyCode } = require('../email');
const requireAuth = require('../middleware/requireAuth');
const crypto = require('crypto');

const router = express.Router();

const genCode = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');
const hashCode = (c) => crypto.createHash('sha256').update(c).digest('hex');

/** Создаёт новый код подтверждения почты (старые для этого юзера гасит). Возвращает код. */
async function issueVerifyCode(userId) {
  const code = genCode();
  await pool.query("DELETE FROM email_codes WHERE user_id=$1 AND purpose='verify'", [userId]);
  await pool.query(
    "INSERT INTO email_codes (user_id, purpose, code_hash, expires_at) VALUES ($1,'verify',$2, now() + interval '15 minutes')",
    [userId, hashCode(code)]
  );
  return code;
}

const REFRESH_COOKIE = 'ff_refresh';
const cookieOpts = () => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  maxAge: parseInt(process.env.REFRESH_TOKEN_TTL_DAYS || '30', 10) * 24 * 60 * 60 * 1000,
  path: '/api/auth',
});

const { planInfo } = require('../plan');
const { isAdminEmail } = require('../middleware/requireAdmin');

function toPublicUser(row) {
  const p = planInfo(row);
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    surname: row.surname,
    avatar: row.avatar,
    photoUrl: row.photo_url,
    currency: row.currency,
    theme: row.theme,
    accentHue: row.accent_hue,
    dashboardWidgets: row.dashboard_widgets,
    watchlist: Array.isArray(row.watchlist) ? row.watchlist : [],
    nwAlertPct: row.nw_alert_pct != null ? Number(row.nw_alert_pct) : 10,
    twofa: row.totp_enabled,
    emailVerified: row.email_verified !== false,
    createdAt: row.created_at,
    tier: p.tier,
    tierUntil: p.tierUntil,
    lifetime: p.lifetime,
    promoDiscount: p.promoDiscount,
    accountLimit: p.accountLimit,
    isAdmin: isAdminEmail(row.email),
  };
}

async function issueSession(res, userId) {
  const accessToken = signAccessToken(userId);
  const refreshToken = generateRefreshToken();
  await pool.query(
    'INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1,$2,$3)',
    [userId, hashRefreshToken(refreshToken), refreshExpiryDate()]
  );
  pool.query('UPDATE users SET last_seen=now() WHERE id=$1', [userId]).catch(() => {});
  res.cookie(REFRESH_COOKIE, refreshToken, cookieOpts());
  return accessToken;
}

// ── POST /api/auth/register ──────────────────────────────
const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  name: z.string().min(1).max(80),
  surname: z.string().max(80).optional(),
});
router.post('/register', async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Некорректные данные', details: parsed.error.flatten() });
  const { email, password, name, surname } = parsed.data;
  const normalizedEmail = email.trim().toLowerCase();

  const existing = await pool.query('SELECT id FROM users WHERE email=$1', [normalizedEmail]);
  if (existing.rowCount > 0) return res.status(409).json({ error: 'Аккаунт с таким email уже существует' });

  const passwordHash = await hashPassword(password);
  const result = await pool.query(
    `INSERT INTO users (email, password_hash, name, surname)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [normalizedEmail, passwordHash, name, surname || null]
  );
  const user = result.rows[0];
  // новый пользователь — почта не подтверждена
  await pool.query('UPDATE users SET email_verified=false WHERE id=$1', [user.id]);
  user.email_verified = false;

  const accessToken = await issueSession(res, user.id);
  logEvent(user.id, 'register', { email: user.email });

  // код на почту — «в фоне», регистрацию не роняем, если письмо не ушло
  issueVerifyCode(user.id)
    .then((code) => sendVerifyCode(user.email, code))
    .catch((e) => console.error('verify email send failed:', e.message));

  res.status(201).json({ accessToken, user: toPublicUser(user) });
});

// ── POST /api/auth/login ──────────────────────────────────
const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });
router.post('/login', async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Некорректные данные' });
  const email = parsed.data.email.trim().toLowerCase();

  const result = await pool.query('SELECT * FROM users WHERE email=$1', [email]);
  const user = result.rows[0];
  // Одинаковое сообщение для «нет пользователя» и «неверный пароль» — чтобы не раскрывать,
  // какие email зарегистрированы.
  if (!user || !(await verifyPassword(parsed.data.password, user.password_hash))) {
    return res.status(401).json({ error: 'Неверный email или пароль' });
  }

  if (user.totp_enabled) {
    const tempToken = signTempToken(user.id);
    return res.json({ requires2FA: true, tempToken });
  }

  const accessToken = await issueSession(res, user.id);
  logEvent(user.id, 'login');
  res.json({ accessToken, user: toPublicUser(user) });
});

// ── POST /api/auth/2fa/verify — второй шаг входа при включённой 2FA ──
const verify2faSchema = z.object({ tempToken: z.string(), code: z.string().length(6) });
router.post('/2fa/verify', async (req, res) => {
  const parsed = verify2faSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Некорректные данные' });

  let payload;
  try {
    payload = verifyTempToken(parsed.data.tempToken);
  } catch {
    return res.status(401).json({ error: 'Сессия входа истекла, попробуй снова' });
  }

  const result = await pool.query('SELECT * FROM users WHERE id=$1', [payload.sub]);
  const user = result.rows[0];
  if (!user || !user.totp_enabled) return res.status(400).json({ error: '2FA не включена для этого аккаунта' });
  if (!verifyTotp(parsed.data.code, user.totp_secret)) {
    return res.status(401).json({ error: 'Неверный код' });
  }

  const accessToken = await issueSession(res, user.id);
  logEvent(user.id, 'login_2fa');
  res.json({ accessToken, user: toPublicUser(user) });
});

// ── POST /api/auth/refresh — выдать новый access-токен по refresh-cookie ──
router.post('/refresh', async (req, res) => {
  const token = req.cookies?.[REFRESH_COOKIE];
  if (!token) return res.status(401).json({ error: 'Нет refresh-токена' });

  const tokenHash = hashRefreshToken(token);
  const result = await pool.query(
    'SELECT * FROM refresh_tokens WHERE token_hash=$1 AND expires_at > now()',
    [tokenHash]
  );
  const row = result.rows[0];
  if (!row) return res.status(401).json({ error: 'Refresh-токен недействителен или истёк' });

  // Ротация: старый токен удаляем, выдаём новый — так утечка одного токена не даёт бессрочный доступ.
  await pool.query('DELETE FROM refresh_tokens WHERE id=$1', [row.id]);
  const userResult = await pool.query('SELECT * FROM users WHERE id=$1', [row.user_id]);
  if (!userResult.rowCount) return res.status(401).json({ error: 'Пользователь не найден' });

  const accessToken = await issueSession(res, row.user_id);
  res.json({ accessToken, user: toPublicUser(userResult.rows[0]) });
});

// ── POST /api/auth/logout ─────────────────────────────────
router.post('/logout', async (req, res) => {
  const token = req.cookies?.[REFRESH_COOKIE];
  if (token) {
    await pool.query('DELETE FROM refresh_tokens WHERE token_hash=$1', [hashRefreshToken(token)]);
  }
  res.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
  res.json({ ok: true });
});

// ── POST /api/auth/verify-email — подтвердить почту 6-значным кодом ──
const verifyEmailSchema = z.object({ code: z.string().regex(/^\d{6}$/) });
router.post('/verify-email', requireAuth, async (req, res) => {
  const parsed = verifyEmailSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Введи 6-значный код' });

  const u = (await pool.query('SELECT * FROM users WHERE id=$1', [req.userId])).rows[0];
  if (!u) return res.status(404).json({ error: 'Пользователь не найден' });
  if (u.email_verified) return res.json({ ok: true, user: toPublicUser(u) });

  const row = (
    await pool.query(
      "SELECT * FROM email_codes WHERE user_id=$1 AND purpose='verify' ORDER BY created_at DESC LIMIT 1",
      [req.userId]
    )
  ).rows[0];
  if (!row) return res.status(400).json({ error: 'Код не запрашивался — нажми «Отправить снова»' });
  if (new Date(row.expires_at).getTime() < Date.now()) return res.status(410).json({ error: 'Код истёк — запроси новый' });
  if (row.attempts >= 5) return res.status(429).json({ error: 'Слишком много попыток — запроси новый код' });

  if (hashCode(parsed.data.code) !== row.code_hash) {
    await pool.query('UPDATE email_codes SET attempts = attempts + 1 WHERE id=$1', [row.id]);
    return res.status(401).json({ error: 'Неверный код' });
  }

  await pool.query('UPDATE users SET email_verified=true WHERE id=$1', [req.userId]);
  await pool.query("DELETE FROM email_codes WHERE user_id=$1 AND purpose='verify'", [req.userId]);
  logEvent(req.userId, 'email_verified');
  const fresh = (await pool.query('SELECT * FROM users WHERE id=$1', [req.userId])).rows[0];
  res.json({ ok: true, user: toPublicUser(fresh) });
});

// ── POST /api/auth/verify-email/resend — прислать новый код (кулдаун 60 сек) ──
router.post('/verify-email/resend', requireAuth, async (req, res) => {
  const u = (await pool.query('SELECT email, email_verified FROM users WHERE id=$1', [req.userId])).rows[0];
  if (!u) return res.status(404).json({ error: 'Пользователь не найден' });
  if (u.email_verified) return res.json({ ok: true, alreadyVerified: true });

  const last = (
    await pool.query(
      "SELECT created_at FROM email_codes WHERE user_id=$1 AND purpose='verify' ORDER BY created_at DESC LIMIT 1",
      [req.userId]
    )
  ).rows[0];
  if (last && Date.now() - new Date(last.created_at).getTime() < 60_000) {
    return res.status(429).json({ error: 'Новый код можно запросить через минуту' });
  }

  const code = await issueVerifyCode(req.userId);
  try {
    await sendVerifyCode(u.email, code);
  } catch (e) {
    console.error('resend verify email failed:', e.message);
    return res.status(502).json({ error: 'Не удалось отправить письмо, попробуй позже' });
  }
  res.json({ ok: true });
});

module.exports = { router, toPublicUser };
