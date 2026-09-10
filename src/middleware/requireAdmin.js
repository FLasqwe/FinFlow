const pool = require('../db/pool');

// Список админов — из переменной окружения ADMIN_EMAILS (через запятую).
// Пусто → админов нет (безопасно по умолчанию).
const ADMINS = (process.env.ADMIN_EMAILS || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

function isAdminEmail(email) {
  return !!email && ADMINS.includes(email.toLowerCase());
}

// Ставится ПОСЛЕ requireAuth.
async function requireAdmin(req, res, next) {
  if (!ADMINS.length) return res.status(403).json({ error: 'Админка отключена (ADMIN_EMAILS не задан)' });
  const { rows } = await pool.query('SELECT email FROM users WHERE id=$1', [req.userId]);
  if (rows[0] && isAdminEmail(rows[0].email)) return next();
  return res.status(403).json({ error: 'Доступ только для администратора' });
}

module.exports = { requireAdmin, isAdminEmail };
