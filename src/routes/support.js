const express = require('express');
const { z } = require('zod');
const pool = require('../db/pool');
const requireAuth = require('../middleware/requireAuth');
const { botReply, GREETING } = require('../supportbot');
const { logEvent } = require('../events');

const router = express.Router();
router.use(requireAuth);

function msg(row) {
  return { id: row.id, sender: row.sender, body: row.body, createdAt: row.created_at };
}
function threadOut(t) {
  return { id: t.id, status: t.status, needsHuman: t.needs_human };
}

/** Тред пользователя (один активный). Создаётся лениво с приветствием бота. */
async function getOrCreateThread(userId) {
  let t = (
    await pool.query(
      "SELECT * FROM support_threads WHERE user_id=$1 AND status<>'closed' ORDER BY created_at DESC LIMIT 1",
      [userId]
    )
  ).rows[0];
  if (t) return t;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    t = (await client.query('INSERT INTO support_threads (user_id) VALUES ($1) RETURNING *', [userId])).rows[0];
    await client.query("INSERT INTO support_messages (thread_id, sender, body) VALUES ($1,'bot',$2)", [t.id, GREETING]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  return t;
}

async function messagesOf(threadId) {
  const { rows } = await pool.query(
    'SELECT * FROM support_messages WHERE thread_id=$1 ORDER BY created_at',
    [threadId]
  );
  return rows.map(msg);
}

// ── GET /api/support ── тред + история
router.get('/', async (req, res) => {
  const t = await getOrCreateThread(req.userId);
  res.json({ thread: threadOut(t), messages: await messagesOf(t.id) });
});

// ── POST /api/support/messages ── сообщение пользователя (+ ответ бота)
const sendSchema = z.object({ body: z.string().min(1).max(2000) });
router.post('/messages', async (req, res) => {
  const parsed = sendSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Пустое или слишком длинное сообщение' });
  const t = await getOrCreateThread(req.userId);

  await pool.query("INSERT INTO support_messages (thread_id, sender, body) VALUES ($1,'user',$2)", [t.id, parsed.data.body]);
  await pool.query('UPDATE support_threads SET last_message_at=now() WHERE id=$1', [t.id]);
  logEvent(req.userId, 'support_message', { threadId: t.id });

  // бот молчит, если уже ждём человека
  if (t.status !== 'waiting_human') {
    const { reply } = botReply(parsed.data.body);
    await pool.query("INSERT INTO support_messages (thread_id, sender, body) VALUES ($1,'bot',$2)", [t.id, reply]);
    if (t.status === 'answered') await pool.query("UPDATE support_threads SET status='bot' WHERE id=$1", [t.id]);
  }

  const fresh = (await pool.query('SELECT * FROM support_threads WHERE id=$1', [t.id])).rows[0];
  res.json({ thread: threadOut(fresh), messages: await messagesOf(t.id) });
});

// ── POST /api/support/human ── позвать живого человека
router.post('/human', async (req, res) => {
  const t = await getOrCreateThread(req.userId);
  await pool.query("UPDATE support_threads SET needs_human=true, status='waiting_human', last_message_at=now() WHERE id=$1", [t.id]);
  await pool.query(
    "INSERT INTO support_messages (thread_id, sender, body) VALUES ($1,'bot',$2)",
    [t.id, 'Позвал поддержку — вам ответят здесь же. Обычно в течение суток. Можно продолжать писать подробности.']
  );
  logEvent(req.userId, 'support_human', { threadId: t.id });
  const fresh = (await pool.query('SELECT * FROM support_threads WHERE id=$1', [t.id])).rows[0];
  res.json({ thread: threadOut(fresh), messages: await messagesOf(t.id) });
});

module.exports = router;
