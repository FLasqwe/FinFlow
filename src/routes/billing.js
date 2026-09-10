const express = require('express');
const { z } = require('zod');
const pool = require('../db/pool');
const requireAuth = require('../middleware/requireAuth');
const { planInfo, LIFETIME, TIER_LABEL, RANK, effectiveTier } = require('../plan');

const router = express.Router();
router.use(requireAuth);

// Каталог тарифов для экрана «Тариф» (пока без цен — оплата позже).
const CATALOG = [
  { id: 'free', label: 'Free', features: ['Транзакции, бюджеты, аналитика', 'До 50 транзакций в месяц', '1 счёт'] },
  { id: 'pro', label: 'Pro', features: ['Всё из Free без лимитов', 'Портфель, рынки, криптовалюты', 'Регулярные транзакции', 'Экспорт CSV / JSON / отчёт', 'Мультивалюта', 'До 5 счетов'] },
  { id: 'premium', label: 'Premium', features: ['Всё из Pro', 'Импорт выписок банка', 'Цели накоплений', 'Уведомления: бюджет и цена', 'История капитала и прогнозы', 'Счета без ограничений'] },
  { id: 'business', label: 'Business', features: ['Всё из Premium', 'Семейный / общий доступ (скоро)', 'Приоритетная поддержка'] },
];

async function currentPlan(userId) {
  const { rows } = await pool.query(
    'SELECT tier, tier_until, tier_source, promo_discount FROM users WHERE id=$1',
    [userId]
  );
  return planInfo(rows[0] || {});
}

// ── GET /api/billing — текущий тариф + каталог ──
router.get('/', async (req, res) => {
  res.json({ ...(await currentPlan(req.userId)), catalog: CATALOG });
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
    const dup = await client.query('SELECT 1 FROM promo_redemptions WHERE code=$1 AND user_id=$2', [code, req.userId]);
    if (dup.rowCount) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Этот промокод уже активирован' }); }

    await client.query('INSERT INTO promo_redemptions (code, user_id) VALUES ($1,$2)', [code, req.userId]);
    await client.query('UPDATE promo_codes SET used_count = used_count + 1 WHERE code=$1', [code]);

    const grantTier = promo.grants_tier || 'pro';
    const grantLabel = TIER_LABEL[grantTier] || grantTier;

    // Текущий действующий тариф пользователя (учёт срока).
    const meRow = (await client.query('SELECT tier, tier_until FROM users WHERE id=$1', [req.userId])).rows[0] || {};
    const curTier = effectiveTier(meRow);
    const curLabel = TIER_LABEL[curTier] || curTier;
    const curLifetime = meRow.tier_until && new Date(meRow.tier_until).getUTCFullYear() >= 2099;
    const isUpgrade = (RANK[grantTier] || 0) > (RANK[curTier] || 0);
    const isSame = grantTier === curTier;

    let message;
    if (promo.kind === 'percent') {
      await client.query('UPDATE users SET promo_discount=$1 WHERE id=$2', [promo.value, req.userId]);
      message = `Скидка ${promo.value}% сохранена — применится при оплате картой.`;
    } else if (!isUpgrade && !isSame) {
      // Промокод на тариф ниже текущего — не понижаем.
      message = `Код на ${grantLabel}, а у тебя ${curLabel} — оставили твой тариф.`;
    } else if (promo.kind === 'free_forever') {
      await client.query('UPDATE users SET tier=$1, tier_until=$2, tier_source=$3 WHERE id=$4',
        [grantTier, LIFETIME, 'promo', req.userId]);
      message = `${grantLabel} активирован навсегда 🎉`;
    } else { // free_days, апгрейд или продление того же тарифа
      const days = promo.value || 0;
      if (isSame && curLifetime) {
        message = `У тебя уже бессрочный ${curLabel} — код не понадобился.`;
      } else if (isUpgrade) {
        await client.query(
          `UPDATE users SET tier=$1, tier_until = now() + ($2 || ' days')::interval, tier_source='promo' WHERE id=$3`,
          [grantTier, String(days), req.userId]
        );
        message = `${grantLabel} активирован на ${days} дн.`;
      } else { // isSame, срочный — продлеваем
        await client.query(
          `UPDATE users SET tier_until = GREATEST(COALESCE(tier_until, now()), now()) + ($1 || ' days')::interval, tier_source='promo' WHERE id=$2`,
          [String(days), req.userId]
        );
        message = `${curLabel} продлён на ${days} дн.`;
      }
    }

    await client.query('COMMIT');
    const plan = await currentPlan(req.userId);
    res.json({ ...plan, catalog: CATALOG, message });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

module.exports = router;
