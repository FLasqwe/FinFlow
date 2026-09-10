// Тарифы пользователя: free < pro < premium < business.
// Активны, пока users.tier_until в будущем (или tier='free').

const TIERS = ['free', 'pro', 'premium', 'business'];
const RANK = { free: 0, pro: 1, premium: 2, business: 3 };

const FREE_TX_PER_MONTH = 50;
const ACCOUNT_LIMIT = { free: 1, pro: 5, premium: Infinity, business: Infinity };
const WALLET_LIMIT = { free: 2, pro: 10, premium: Infinity, business: Infinity };
const LIFETIME = '2099-12-31T00:00:00Z';

const TIER_LABEL = { free: 'Free', pro: 'Pro', premium: 'Premium', business: 'Business' };

/** Действующий тариф с учётом срока. */
function effectiveTier(u) {
  if (!u || !u.tier || u.tier === 'free') return 'free';
  if (u.tier_until && new Date(u.tier_until).getTime() <= Date.now()) return 'free';
  return TIERS.includes(u.tier) ? u.tier : 'free';
}

/** Тариф пользователя не ниже min ('pro' | 'premium' | 'business'). */
function tierAtLeast(u, min) {
  return RANK[effectiveTier(u)] >= (RANK[min] ?? 99);
}

function accountLimit(u) {
  return ACCOUNT_LIMIT[effectiveTier(u)];
}

function walletLimit(u) {
  return WALLET_LIMIT[effectiveTier(u)];
}

function planInfo(u) {
  const tier = effectiveTier(u);
  const until = tier !== 'free' && u && u.tier_until ? new Date(u.tier_until) : null;
  return {
    tier,
    tierUntil: until ? until.toISOString() : null,
    lifetime: !!(until && until.getUTCFullYear() >= 2099),
    tierSource: tier !== 'free' && u ? u.tier_source || null : null,
    promoDiscount: u && u.promo_discount ? Number(u.promo_discount) : null,
    accountLimit: ACCOUNT_LIMIT[tier] === Infinity ? null : ACCOUNT_LIMIT[tier],
    txPerMonth: tier === 'free' ? FREE_TX_PER_MONTH : null,
  };
}

module.exports = {
  TIERS, RANK, TIER_LABEL, FREE_TX_PER_MONTH, ACCOUNT_LIMIT, WALLET_LIMIT, LIFETIME,
  effectiveTier, tierAtLeast, accountLimit, walletLimit, planInfo,
};
