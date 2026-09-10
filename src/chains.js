// Чтение баланса крипто-адреса из публичных эксплореров. Только чтение —
// приватные ключи здесь не фигурируют в принципе.
//
// BTC  → blockstream.info (без ключа)
// ETH  → публичный JSON-RPC eth_getBalance (без ключа), только нативный ETH
// TON  → toncenter.com v2 getAddressBalance (без ключа, мягкий лимит)

const CHAINS = {
  BTC: { name: 'Bitcoin', sym: 'BTC', decimals: 8 },
  ETH: { name: 'Ethereum', sym: 'ETH', decimals: 18 },
  TON: { name: 'Toncoin', sym: 'TON', decimals: 9 },
};
const CHAIN_IDS = Object.keys(CHAINS);

// ── Проверка формата адреса (грубая, чтобы отсечь мусор) ──
const RE = {
  BTC: /^(bc1[a-z0-9]{20,80}|[13][a-km-zA-HJ-NP-Z1-9]{25,39})$/,
  ETH: /^0x[a-fA-F0-9]{40}$/,
  TON: /^([EUkn0]Q[A-Za-z0-9_-]{46}|-?[0-9]:[a-fA-F0-9]{64})$/,
};

function validateAddress(chain, address) {
  const a = String(address || '').trim();
  if (!CHAINS[chain]) return { ok: false, error: 'Неизвестная сеть' };
  if (!a) return { ok: false, error: 'Пустой адрес' };
  if (a.length > 120) return { ok: false, error: 'Слишком длинный адрес' };
  if (!RE[chain].test(a)) return { ok: false, error: `Не похоже на адрес ${chain}` };
  return { ok: true, address: a };
}

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, { signal: AbortSignal.timeout(12_000), ...opts });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// Возвращает баланс адреса в нативных единицах (BTC / ETH / TON) как число.
async function fetchNativeBalance(chain, address) {
  if (chain === 'BTC') {
    const d = await fetchJson(`https://blockstream.info/api/address/${address}`);
    const c = d.chain_stats || {};
    const m = d.mempool_stats || {};
    const sats =
      (c.funded_txo_sum || 0) - (c.spent_txo_sum || 0) +
      (m.funded_txo_sum || 0) - (m.spent_txo_sum || 0);
    return sats / 1e8;
  }

  if (chain === 'ETH') {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [address, 'latest'] });
    const rpcs = [
      'https://ethereum-rpc.publicnode.com',
      'https://eth.drpc.org',
      'https://cloudflare-eth.com',
    ];
    let lastErr = new Error('RPC недоступен');
    for (const url of rpcs) {
      try {
        const d = await fetchJson(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        });
        if (d && typeof d.result === 'string' && d.result.startsWith('0x')) {
          return Number(BigInt(d.result)) / 1e18;
        }
        lastErr = new Error(d && d.error ? (d.error.message || 'Ошибка RPC') : 'Пустой ответ RPC');
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr;
  }

  if (chain === 'TON') {
    const d = await fetchJson(
      `https://toncenter.com/api/v2/getAddressBalance?address=${encodeURIComponent(address)}`
    );
    if (!d || d.ok !== true) throw new Error('Ошибка toncenter');
    return Number(d.result) / 1e9;
  }

  throw new Error('Неизвестная сеть');
}

module.exports = { CHAINS, CHAIN_IDS, validateAddress, fetchNativeBalance };
