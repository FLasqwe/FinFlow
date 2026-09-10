const pool = require('../db/pool');
const { isPro } = require('../plan');

/**
 * Пропускает только пользователей с активным тарифом Pro.
 * Ставится ПОСЛЕ requireAuth (нужен req.userId).
 * Ответ 402 (Payment Required) с { error, upgrade:true } — фронт по этому флагу
 * показывает экран «Тариф».
 */
async function requirePro(req, res, next) {
  const { rows } = await pool.query('SELECT pro_until FROM users WHERE id=$1', [req.userId]);
  if (rows[0] && isPro(rows[0])) return next();
  return res.status(402).json({ error: 'Нужен тариф Pro', upgrade: true });
}

module.exports = requirePro;
