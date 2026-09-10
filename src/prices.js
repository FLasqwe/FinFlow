// Курсы криптовалют в USD с CoinGecko + кэш на 20 сек (чтобы не упираться в лимиты).

const COINS = {
  BTC: { cg: 'bitcoin', name: 'Bitcoin' },
  ETH: { cg: 'ethereum', name: 'Ethereum' },
  BNB: { cg: 'binancecoin', name: 'BNB' },
  SOL: { cg: 'solana', name: 'Solana' },
  XRP: { cg: 'ripple', name: 'XRP' },
  ADA: { cg: 'cardano', name: 'Cardano' },
  DOGE: { cg: 'dogecoin', name: 'Dogecoin' },
  TON: { cg: 'the-open-network', name: 'Toncoin' },
  AVAX: { cg: 'avalanche-2', name: 'Avalanche' },
  LINK: { cg: 'chainlink', name: 'Chainlink' },
  DOT: { cg: 'polkadot', name: 'Polkadot' },
  MATIC: { cg: 'matic-network', name: 'Polygon' },
};
const SYMS = Object.keys(COINS);
const CG_TO_SYM = Object.fromEntries(SYMS.map((s) => [COINS[s].cg, s]));

let cache = { at: 0, prices: {} };

async function getPrices() {
  if (Date.now() - cache.at < 20_000 && Object.keys(cache.prices).length) return cache.prices;
  const ids = SYMS.map((s) => COINS[s].cg).join(',');
  const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`);
  if (!res.ok) throw new Error('Не удалось получить котировки (' + res.status + ')');
  const data = await res.json();
  const prices = {};
  for (const [cg, obj] of Object.entries(data)) {
    if (CG_TO_SYM[cg] && obj && typeof obj.usd === 'number') prices[CG_TO_SYM[cg]] = obj.usd;
  }
  if (!Object.keys(prices).length) throw new Error('Пустой ответ от CoinGecko');
  cache = { at: Date.now(), prices };
  return prices;
}

async function priceOf(sym) {
  const p = await getPrices();
  return p[sym] || null;
}

module.exports = { COINS, SYMS, getPrices, priceOf };
