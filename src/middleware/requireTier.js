const pool = require('../db/pool');
const { tierAtLeast, TIER_LABEL } = require('../plan');

/**
 * Фабрика middleware: пропускает только пользователей с тарифом не ниже `min`.
 * Ставится ПОСЛЕ requireAuth (нужен req.userId).
 * Отказ — 402 { error, upgrade:true, need:<min> } — фронт по этому флагу ведёт на «Тариф».
 */
function requireTier(min) {
  return async function (req, res, next) {
    const { rows } = await pool.query('SELECT tier, tier_until FROM users WHERE id=$1', [req.userId]);
    if (rows[0] && tierAtLeast(rows[0], min)) return next();
    return res.status(402).json({ error: `Нужен тариф ${TIER_LABEL[min] || min}`, upgrade: true, need: min });
  };
}

module.exports = requireTier;
