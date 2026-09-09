const { Pool } = require('pg');

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
