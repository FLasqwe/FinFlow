const express = require('express');
const { z } = require('zod');
const pool = require('../db/pool');
const requireAuth = require('../middleware/requireAuth');
const { checkNetWorthAlerts } = require('../alerts');

const router = express.Router();
router.use(requireAuth);

// ── POST /api/networth/snapshot ──
// Фронтенд сам считает чистый капитал (там курсы и конвертация) и присылает
// сюда результат. На один день — одна запись (upsert).
const snapSchema = z.object({
  total: z.number().finite(),
  currency: z.string().length(3).optional(),
  breakdown: z.record(z.string(), z.number()).optional(),
});
router.post('/snapshot', async (req, res) => {
  const parsed = snapSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Некорректные данные' });
  const { total, breakdown } = parsed.data;
  const currency = (parsed.data.currency || 'USD').toUpperCase();
  const { rows } = await pool.query(
    `INSERT INTO networth_snapshots (user_id, day, total, currency, breakdown)
     VALUES ($1, CURRENT_DATE, $2, $3, $4)
     ON CONFLICT (user_id, day)
     DO UPDATE SET total = EXCLUDED.total, currency = EXCLUDED.currency,
                   breakdown = EXCLUDED.breakdown, created_at = now()
     RETURNING day, total, currency, breakdown`,
    [req.userId, total, currency, breakdown ? JSON.stringify(breakdown) : null]
  );

  // Оповещения о просадке / новом максимуме — по последним 30 дням (не блокируем ответ).
  (async () => {
    try {
      const [hist, u] = await Promise.all([
        pool.query(
          `SELECT day, total, currency FROM networth_snapshots
           WHERE user_id=$1 AND day >= CURRENT_DATE - 30 ORDER BY day ASC`,
          [req.userId]
        ),
        pool.query('SELECT nw_alert_pct FROM users WHERE id=$1', [req.userId]),
      ]);
      await checkNetWorthAlerts(req.userId, hist.rows, u.rows[0] ? u.rows[0].nw_alert_pct : 10);
    } catch (e) {
      console.error('nw alert check failed:', e.message);
    }
  })();

  res.json({ snapshot: publicRow(rows[0]) });
});

// ── GET /api/networth?days=365 ──
router.get('/', async (req, res) => {
  const days = Math.min(1825, Math.max(7, parseInt(req.query.days, 10) || 365));
  const { rows } = await pool.query(
    `SELECT day, total, currency, breakdown FROM networth_snapshots
     WHERE user_id = $1 AND day >= CURRENT_DATE - $2::int
     ORDER BY day ASC`,
    [req.userId, days]
  );
  const history = rows.map(publicRow);
  res.json({ history, ...summarize(history) });
});

function publicRow(r) {
  return {
    day: r.day, // строка 'YYYY-MM-DD' (types.setTypeParser 1082)
    total: Number(r.total),
    currency: r.currency,
    breakdown: r.breakdown || null,
  };
}

// Дельта за ~30 дней относительно последнего снимка (в валюте снимков как есть —
// фронтенд при желании конвертирует). Считаем по ближайшему снимку не новее чем
// 30 дней назад.
function summarize(history) {
  if (!history.length) return { first: null, last: null, change30: null, changePct30: null };
  const last = history[history.length - 1];
  const target = new Date(last.day);
  target.setDate(target.getDate() - 30);
  let base = history[0];
  for (const h of history) {
    if (new Date(h.day) <= target) base = h;
    else break;
  }
  const change30 = last.total - base.total;
  const changePct30 = base.total !== 0 ? (change30 / Math.abs(base.total)) * 100 : null;
  return { first: history[0], last, change30, changePct30 };
}

module.exports = router;
