// Применяет schema.sql к базе данных, указанной в DATABASE_URL.
// Запуск: npm run migrate
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('❌ Не задан DATABASE_URL. Скопируй .env.example в .env и заполни его.');
    process.exit(1);
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  console.log('▶ Применяю schema.sql...');
  try {
    await pool.query(sql);
    console.log('✅ Схема базы данных готова.');
  } catch (err) {
    console.error('❌ Ошибка миграции:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();
