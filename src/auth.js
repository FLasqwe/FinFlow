const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { authenticator } = require('otplib');

const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET;
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET;
const ACCESS_TTL = process.env.ACCESS_TOKEN_TTL || '15m';
const REFRESH_TTL_DAYS = parseInt(process.env.REFRESH_TOKEN_TTL_DAYS || '30', 10);

if (!ACCESS_SECRET || !REFRESH_SECRET || ACCESS_SECRET === 'change_me_access_secret') {
  console.warn(
    '⚠️  JWT_ACCESS_SECRET/JWT_REFRESH_SECRET не заданы или используют значение по умолчанию — ' +
    'сгенерируй свои перед деплоем в продакшн: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"'
  );
}

// ── Пароли ──────────────────────────────────────────────
async function hashPassword(plain) {
  return bcrypt.hash(plain, 12);
}
async function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

// ── JWT access/refresh токены ───────────────────────────
function signAccessToken(userId) {
  return jwt.sign({ sub: userId, typ: 'access' }, ACCESS_SECRET, { expiresIn: ACCESS_TTL });
}
function signTempToken(userId) {
  // короткоживущий токен между шагом "пароль верный" и шагом "введи код 2FA"
  return jwt.sign({ sub: userId, typ: 'temp_2fa' }, ACCESS_SECRET, { expiresIn: '5m' });
}
function verifyAccessToken(token) {
  const payload = jwt.verify(token, ACCESS_SECRET);
  if (payload.typ !== 'access') throw new Error('Неверный тип токена');
  return payload;
}
function verifyTempToken(token) {
  const payload = jwt.verify(token, ACCESS_SECRET);
  if (payload.typ !== 'temp_2fa') throw new Error('Неверный тип токена');
  return payload;
}

function generateRefreshToken() {
  return crypto.randomBytes(48).toString('hex');
}
function hashRefreshToken(token) {
  // Сам refresh-токен нигде не хранится — только его хэш, как и пароль.
  return crypto.createHash('sha256').update(token).digest('hex');
}
function refreshExpiryDate() {
  return new Date(Date.now() + REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000);
}

// ── TOTP (двухфакторная аутентификация) ─────────────────
// Настоящий RFC 6238 TOTP — совместим с Google Authenticator, Яндекс.Ключ, Authy и т.п.
function generateTotpSecret() {
  return authenticator.generateSecret();
}
function totpKeyUri(email, secret) {
  const issuer = process.env.TOTP_ISSUER || 'FinFlow';
  return authenticator.keyuri(email, issuer, secret);
}
function verifyTotp(token, secret) {
  try {
    return authenticator.verify({ token, secret });
  } catch {
    return false;
  }
}

module.exports = {
  hashPassword,
  verifyPassword,
  signAccessToken,
  signTempToken,
  verifyAccessToken,
  verifyTempToken,
  generateRefreshToken,
  hashRefreshToken,
  refreshExpiryDate,
  generateTotpSecret,
  totpKeyUri,
  verifyTotp,
};
