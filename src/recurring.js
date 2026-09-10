// Материализация регулярных правил в обычные транзакции.
// Вызывается при чтении списка транзакций (GET /api/transactions) — так открытие
// приложения подтягивает всё, что «набежало» с прошлого раза.
//
// Даты считаются в UTC (Railway работает в UTC). Возможная погрешность в пару часов
// около полуночи некритична для регулярных платежей.

const pool = require('./db/pool');
const { isPro } = require('./plan');

const DAY = 86400000;
const iso = (d) => d.toISOString().slice(0, 10);
const parse = (s) => new Date(s + 'T00:00:00Z');
const todayISO = () => iso(new Date());
const daysInMonth = (year, month0) => new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
const maxIso = (a, b) => (a > b ? a : b);
const minIso = (a, b) => (a < b ? a : b);

/**
 * Даты вхождений правила в интервале [fromISO, toISO] включительно.
 * @returns {string[]} массив 'YYYY-MM-DD'
 */
function occurrences(rule, fromISO, toISO) {
  if (fromISO > toISO) return [];
  const out = [];
  const from = parse(fromISO);
  const to = parse(toISO);
  const CAP = 400; // страховка от «убежавшего» правила

  if (rule.cadence === 'weekly') {
    const dow = rule.day_of_week ?? 1;
    for (let t = from.getTime(); t <= to.getTime() && out.length < CAP; t += DAY) {
      if (new Date(t).getUTCDay() === dow) out.push(iso(new Date(t)));
    }
    return out;
  }

  // monthly / yearly — идём по месяцам
  const dom = rule.day_of_month ?? 1;
  let y = from.getUTCFullYear();
  let m = from.getUTCMonth(); // 0-11
  while (out.length < CAP) {
    const first = Date.UTC(y, m, 1);
    if (first > to.getTime() + 31 * DAY) break;
    const okMonth = rule.cadence === 'monthly' || m === (rule.month_of_year ?? 1) - 1;
    if (okMonth) {
      const day = Math.min(dom, daysInMonth(y, m));
      const occ = new Date(Date.UTC(y, m, day));
      if (occ >= from && occ <= to) out.push(iso(occ));
    }
    m += 1;
    if (m > 11) { m = 0; y += 1; }
    if (Date.UTC(y, m, 1) > to.getTime()) break;
  }
  return out;
}

/** Следующая дата вхождения строго после «сегодня» (для показа в UI). null, если правило завершено. */
function nextDate(rule, fromISO = todayISO()) {
  const start = maxIso(rule.start_date, iso(new Date(parse(fromISO).getTime() + DAY)));
  const horizon = iso(new Date(parse(fromISO).getTime() + 400 * DAY));
  const to = rule.end_date ? minIso(rule.end_date, horizon) : horizon;
  return occurrences(rule, start, to)[0] || null;
}

/**
 * Догоняет все правила пользователя: создаёт недостающие транзакции, двигает last_run.
 * Бэкфила нет — новое правило начинает работать со следующего запланированного дня.
 * @returns {Promise<number>} сколько транзакций создано
 */
async function runRecurringForUser(userId) {
  const today = todayISO();

  // Регулярные правила работают только на активном Pro. Тариф кончился — правила на паузе.
  const { rows: u } = await pool.query('SELECT pro_until FROM users WHERE id=$1', [userId]);
  if (!u[0] || !isPro(u[0])) return 0;

  const { rows: rules } = await pool.query(
    'SELECT * FROM recurring_rules WHERE user_id=$1 AND active=true',
    [userId]
  );
  if (!rules.length) return 0;

  const client = await pool.connect();
  let created = 0;
  try {
    await client.query('BEGIN');
    for (const rule of rules) {
      const from = rule.last_run
        ? iso(new Date(parse(rule.last_run).getTime() + DAY))
        : maxIso(rule.start_date, today);
      const to = rule.end_date ? minIso(rule.end_date, today) : today;
      const dates = occurrences(rule, from, to);
      for (const d of dates) {
        // NOT EXISTS — идемпотентность: даже если last_run по какой-то причине
        // откатился, повторное вхождение (rule.id + дата) не задублируется.
        const r = await client.query(
          `INSERT INTO transactions (user_id, type, amount, category, note, date, recurring_id)
           SELECT $1,$2,$3,$4,$5,$6,$7
           WHERE NOT EXISTS (
             SELECT 1 FROM transactions WHERE recurring_id=$7 AND date=$6
           )`,
          [userId, rule.type, rule.amount, rule.category, rule.note || null, d, rule.id]
        );
        created += r.rowCount;
      }
      await client.query('UPDATE recurring_rules SET last_run=$1 WHERE id=$2', [today, rule.id]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return created;
}

module.exports = { runRecurringForUser, nextDate, occurrences };
