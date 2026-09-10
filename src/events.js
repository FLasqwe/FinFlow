// Журнал событий для админ-панели. Пишется «в фоне» — никогда не роняет запрос.
const pool = require('./db/pool');

function logEvent(userId, type, meta) {
  pool
    .query('INSERT INTO events (user_id, type, meta) VALUES ($1,$2,$3)', [
      userId || null,
      type,
      meta ? JSON.stringify(meta) : null,
    ])
    .catch((e) => console.error('logEvent failed:', e.message));
}

module.exports = { logEvent };
