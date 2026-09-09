const { verifyAccessToken } = require('../auth');

/**
 * Ожидает заголовок  Authorization: Bearer <accessToken>
 * При успехе кладёт req.userId для использования в маршрутах.
 */
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Нужна авторизация' });
  }
  try {
    const payload = verifyAccessToken(token);
    req.userId = payload.sub;
    next();
  } catch {
    return res.status(401).json({ error: 'Токен недействителен или истёк' });
  }
}

module.exports = requireAuth;
