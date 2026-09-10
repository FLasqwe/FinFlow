// Общий помощник: обновить баланс одной строки wallets из публичного эксплорера
// и записать результат. Используется и роутом /api/wallets, и планировщиком.

const pool = require('./db/pool');
const { fetchNativeBalance } = require('./chains');
const { priceOf } = require('./prices');

async function syncWalletRow(row) {
  try {
    const native = await fetchNativeBalance(row.chain, row.address);
    const price = await priceOf(row.chain).catch(() => null);
    const usd = price != null ? native * price : null;
    const { rows } = await pool.query(
      `UPDATE wallets SET last_native=$1, last_price=$2, last_usd=$3, last_sync=now(), sync_error=NULL
       WHERE id=$4 RETURNING *`,
      [native, price, usd, row.id]
    );
    return rows[0];
  } catch (e) {
    const msg = e && e.message ? String(e.message).slice(0, 200) : 'Ошибка синхронизации';
    const { rows } = await pool.query(
      `UPDATE wallets SET last_sync=now(), sync_error=$1 WHERE id=$2 RETURNING *`,
      [msg, row.id]
    );
    return rows[0];
  }
}

module.exports = { syncWalletRow };
