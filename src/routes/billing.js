const express = require('express');
const { z } = require('zod');
const pool = require('../db/pool');
const requireAuth = require('../middleware/requireAuth');
const { planInfo, LIFETIME } = require('../plan');

const router = express.Router();
router.use(requireAuth);

async function currentPlan(userId) {
  const { rows } = await pool.query(
    'SELECT pro_until, pro_source, promo_discount FROM users WHERE id=$1',
    [userId]
  );
  return planInfo(rows[0] || {});
}

// ── GET /api/billing — текущий тариф ──
router.get('/', async (req, res) => {
  res.json(await currentPlan(req.userId));
});

// ── POST /api/billing/redeem — активировать промокод ──
const redeemSchema = z.object({ code: z.string().min(1).max(64) });
router.post('/redeem', async (req, res) => {
  const parsed = redeemSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Введи промокод' });
  const code = parsed.data.code.trim().toUpperCase();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT * FROM promo_codes WHERE code=$1 FOR UPDATE', [code]);
    const promo = rows[0];
    if (!promo) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Промокод не найден' }); }
    if (!promo.active) { await client.query('ROLLBACK'); return res.status(410).json({ error: 'Промокод отключён' }); }
    if (promo.expires_at && new Date(promo.expires_at).getTime() < Date.now()) {
      await client.query('ROLLBACK'); return res.status(410).json({ error: 'Срок действия промокода истёк' });
    }
    if (promo.max_uses != null && promo.used_count >= promo.max_uses) {
      await client.query('ROLLBACK'); return res.status(409).json({ error: 'Лимит активаций промокода исчерпан' });
    }

    const dup = await client.query(
      'SELECT 1 FROM promo_redemptions WHERE code=$1 AND user_id=$2',
      [code, req.userId]
    );
    if (dup.rowCount) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Этот промокод уже активирован' }); }

    await client.query('INSERT INTO promo_redemptions (code, user_id) VALUES ($1,$2)', [code, req.userId]);
    await client.query('UPDATE promo_codes SET used_count = used_count + 1 WHERE code=$1', [code]);

    let message;
    if (promo.kind === 'free_forever') {
      await client.query('UPDATE users SET pro_until=$1, pro_source=$2 WHERE id=$3', [LIFETIME, 'promo', req.userId]);
      message = 'Pro активирован навсегда 🎉';
    } else if (promo.kind === 'free_days') {
      const days = promo.value || 0;
      await client.query(
        `UPDATE users
         SET pro_until = GREATEST(COALESCE(pro_until, now()), now()) + ($1 || ' days')::interval,
             pro_source = 'promo'
         WHERE id=$2`,
        [String(days), req.userId]
      );
      message = `Pro активирован на ${days} дн.`;
    } else { // percent
      await client.query('UPDATE users SET promo_discount=$1 WHERE id=$2', [promo.value, req.userId]);
      message = `Скидка ${promo.value}% сохранена — применится при оплате картой.`;
    }

    await client.query('COMMIT');
    const plan = await currentPlan(req.userId);
    res.json({ ...plan, message });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

module.exports = router;
