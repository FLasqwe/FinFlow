// Простой фоновый планировщик (setInterval, одна инстанция на Railway).
// Задача: раз в час авто-обновлять балансы крипто-кошельков у пользователей
// с тарифом Pro и выше. На free — только ручное обновление.

const pool = require('./db/pool');
const { syncWalletRow } = require('./walletsync');

const TICK_MS = 20 * 60 * 1000;   // как часто просыпаться
const STALE_MS = 55 * 60 * 1000;  // считать баланс устаревшим через 55 мин
const USERS_PER_TICK = 25;        // не больше стольких пользователей за проход
const GAP_MS = 400;               // пауза между запросами к эксплорерам

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function syncStaleWallets() {
  const staleBefore = new Date(Date.now() - STALE_MS).toISOString();
  const { rows: users } = await pool.query(
    `SELECT u.id
       FROM users u
      WHERE u.tier <> 'free'
        AND (u.tier_until IS NULL OR u.tier_until > now())
        AND (u.wallets_synced_at IS NULL OR u.wallets_synced_at < $1)
        AND EXISTS (SELECT 1 FROM wallets w WHERE w.user_id = u.id)
      ORDER BY u.wallets_synced_at ASC NULLS FIRST
      LIMIT $2`,
    [staleBefore, USERS_PER_TICK]
  );
  if (!users.length) return { users: 0, wallets: 0 };

  let walletCount = 0;
  for (const u of users) {
    const { rows: wallets } = await pool.query('SELECT * FROM wallets WHERE user_id=$1', [u.id]);
    for (const w of wallets) {
      await syncWalletRow(w);
      walletCount++;
      await sleep(GAP_MS);
    }
    await pool.query('UPDATE users SET wallets_synced_at = now() WHERE id=$1', [u.id]);
  }
  return { users: users.length, wallets: walletCount };
}

async function tick() {
  try {
    const r = await syncStaleWallets();
    if (r.wallets) console.log(`⏱  авто-синк кошельков: ${r.users} польз., ${r.wallets} кошельков`);
  } catch (e) {
    console.error('scheduler tick failed:', e.message);
  }
}

function start() {
  if (process.env.DISABLE_SCHEDULER === '1') {
    console.log('⏱  планировщик выключен (DISABLE_SCHEDULER=1)');
    return;
  }
  setTimeout(tick, 30_000).unref();        // первый проход вскоре после старта
  setInterval(tick, TICK_MS).unref();
  console.log('⏱  планировщик запущен (авто-синк кошельков Pro раз в ~20 мин)');
}

module.exports = { start, tick, syncStaleWallets };
