// Тариф пользователя. Pro активен, пока users.pro_until в будущем.

const FREE_TX_PER_MONTH = 50;              // лимит ручных транзакций для free
const LIFETIME = '2099-12-31T00:00:00Z';  // «навсегда» = дата далеко вперёд

function isPro(userRow) {
  if (!userRow || !userRow.pro_until) return false;
  return new Date(userRow.pro_until).getTime() > Date.now();
}

function planInfo(userRow) {
  const pro = isPro(userRow);
  return {
    plan: pro ? 'pro' : 'free',
    proUntil: pro ? new Date(userRow.pro_until).toISOString() : null,
    proSource: pro ? userRow.pro_source || null : null,
    promoDiscount: userRow && userRow.promo_discount ? Number(userRow.promo_discount) : null,
    lifetime: pro && new Date(userRow.pro_until).getFullYear() >= 2099,
  };
}

module.exports = { isPro, planInfo, FREE_TX_PER_MONTH, LIFETIME };
