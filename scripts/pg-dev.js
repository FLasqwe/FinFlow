// Локальный PostgreSQL для разработки без Docker.
// Запускает автономный бинарник PostgreSQL (пакет embedded-postgres) на localhost:5432
// с той же базой/логином/паролем, что и docker-compose.yml: finflow / finflow / finflow.
// Данные кластера лежат в ./.pgdata (в .gitignore). Скрипт висит на переднем плане —
// Ctrl+C корректно останавливает сервер БД.
//
//   node scripts/pg-dev.js        (или: npm run db:local)

const fs = require('fs');
const path = require('path');
const EmbeddedPostgres = require('embedded-postgres').default;

const DATA_DIR = path.join(__dirname, '..', '.pgdata');
const PORT = Number(process.env.PGDEV_PORT || 5432);

const pg = new EmbeddedPostgres({
  databaseDir: DATA_DIR,
  user: 'finflow',
  password: 'finflow',
  port: PORT,
  persistent: true,
});

async function main() {
  const initialised = fs.existsSync(path.join(DATA_DIR, 'PG_VERSION'));

  if (!initialised) {
    console.log('▶ Инициализирую кластер PostgreSQL в', DATA_DIR);
    await pg.initialise();
  }

  await pg.start();
  console.log(`✅ PostgreSQL слушает на localhost:${PORT}`);

  if (!initialised) {
    await pg.createDatabase('finflow');
    console.log('✅ База данных "finflow" создана');
  }

  console.log(`   DATABASE_URL=postgresql://finflow:finflow@localhost:${PORT}/finflow`);
  console.log('   Останов: Ctrl+C');
}

async function shutdown() {
  console.log('\n▶ Останавливаю PostgreSQL...');
  try {
    await pg.stop();
  } catch (err) {
    console.error('   (ошибка при остановке, игнорирую):', err.message);
  }
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main().catch((err) => {
  console.error('❌ Не удалось поднять PostgreSQL:', err);
  process.exit(1);
});
