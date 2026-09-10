const express = require('express');
const pool = require('../db/pool');
const requireAuth = require('../middleware/requireAuth');

const router = express.Router();
router.use(requireAuth);

function toPublic(r) {
  return {
    id: r.id,
    type: r.type,
    title: r.title,
    body: r.body || null,
    meta: r.meta || null,
    read: r.read,
    createdAt: r.created_at,
  };
}

// ── GET /api/alerts ──
router.get('/', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM alerts WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50',
    [req.userId]
  );
  const unread = Number(
    (await pool.query('SELECT count(*)::int n FROM alerts WHERE user_id=$1 AND read=false', [req.userId])).rows[0].n
  );
  res.json({ alerts: rows.map(toPublic), unread });
});

// ── POST /api/alerts/read-all ──
router.post('/read-all', async (req, res) => {
  await pool.query('UPDATE alerts SET read=true WHERE user_id=$1 AND read=false', [req.userId]);
  res.json({ ok: true });
});

// ── POST /api/alerts/:id/read ──
router.post('/:id/read', async (req, res) => {
  const { rowCount } = await pool.query(
    'UPDATE alerts SET read=true WHERE id=$1 AND user_id=$2',
    [req.params.id, req.userId]
  );
  if (!rowCount) return res.status(404).json({ error: 'Не найдено' });
  res.json({ ok: true });
});

// ── DELETE /api/alerts/:id ──
router.delete('/:id', async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM alerts WHERE id=$1 AND user_id=$2', [req.params.id, req.userId]);
  if (!rowCount) return res.status(404).json({ error: 'Не найдено' });
  res.json({ ok: true });
});

module.exports = router;
