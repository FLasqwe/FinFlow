const { Pool, types } = require('pg');

// DATE (oid 1082) отдаём как есть — строкой 'YYYY-MM-DD'. Иначе node-pg парсит
// её в JS Date на локальную полночь, и .toISOString() уводит дату на день назад
// в положительных таймзонах (МSK: 2026-09-10 → 2026-09-09).
types.setTypeParser(1082, (v) => v);

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL не задан. Проверь файл .env (см. .env.example).');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Большинство managed-провайдеров (Railway, Render, Supabase) требуют SSL,
  // но с самоподписанным сертификатом — поэтому отключаем строгую проверку.
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});

pool.on('error', (err) => {
  console.error('Неожиданная ошибка пула PostgreSQL:', err);
});

module.exports = pool;
