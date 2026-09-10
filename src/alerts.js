const pool = require('./db/pool');

// Создать уведомление, если такого же типа не было за последние `dedupeHours` часов.
async function pushAlert(userId, type, title, body, meta, dedupeHours = 72) {
  try {
    if (dedupeHours > 0) {
      const dup = await pool.query(
        `SELECT 1 FROM alerts WHERE user_id=$1 AND type=$2 AND created_at > now() - ($3 || ' hours')::interval LIMIT 1`,
        [userId, type, String(dedupeHours)]
      );
      if (dup.rowCount) return null;
    }
    const { rows } = await pool.query(
      `INSERT INTO alerts (user_id, type, title, body, meta) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [userId, type, title, body || null, meta ? JSON.stringify(meta) : null]
    );
    return rows[0];
  } catch (e) {
    console.error('pushAlert failed:', e.message);
    return null;
  }
}

// Проверка просадки/нового максимума по свежему снимку чистого капитала.
// history — массив {day, total} по возрастанию дня; last — самый свежий.
async function checkNetWorthAlerts(userId, history, alertPct) {
  if (!history || history.length < 2) return;
  const last = history[history.length - 1];
  const prev = history.slice(0, -1);
  const peak = Math.max(...prev.map((h) => Number(h.total)));
  const low = Math.min(...prev.map((h) => Number(h.total)));
  const cur = Number(last.total);

  // просадка от 30-дневного пика
  const pct = Number(alertPct);
  if (pct > 0 && peak > 0) {
    const drop = (peak - cur) / peak * 100;
    if (drop >= pct) {
      await pushAlert(
        userId, 'nw_drawdown',
        `Капитал просел на ${drop.toFixed(1)}%`,
        `С недавнего максимума потеряно ${Math.round(peak - cur).toLocaleString('ru-RU')} (${last.currency || ''}). Порог оповещения — ${pct}%.`,
        { peak, cur, dropPct: drop }, 72
      );
    }
  }
  // новый максимум
  if (cur > peak && peak > 0 && (cur - peak) / peak >= 0.02) {
    await pushAlert(
      userId, 'nw_high',
      'Новый максимум капитала 🎉',
      `Чистый капитал впервые выше ${Math.round(peak).toLocaleString('ru-RU')} — сейчас ${Math.round(cur).toLocaleString('ru-RU')} ${last.currency || ''}.`,
      { peak, cur }, 72
    );
  }
}

module.exports = { pushAlert, checkNetWorthAlerts };
