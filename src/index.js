require('dotenv').config();
require('express-async-errors'); // делает так, чтобы отклонённые промисы в async-роутах доходили до error-handler'а
const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');

const { router: authRouter } = require('./routes/auth');
const meRouter = require('./routes/me');
const transactionsRouter = require('./routes/transactions');
const budgetsRouter = require('./routes/budgets');
const portfolioRouter = require('./routes/portfolio');

const app = express();

app.set('trust proxy', 1); // корректные IP за прокси Railway/Render/Fly

// CSP отключён: фронтенд в public/index.html — один большой inline-скрипт со
// множеством inline-обработчиков (onclick=...) и @import Google Fonts. Строгий
// CSP по умолчанию от helmet их все заблокировал бы. Остальные заголовки helmet
// (X-Frame-Options, HSTS, nosniff и т.д.) остаются включёнными.
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cookieParser());
app.use(express.json({ limit: '1mb' }));

const allowedOrigin = process.env.ALLOWED_ORIGIN || '*';
app.use(
  cors({
    origin: allowedOrigin === '*' ? true : allowedOrigin.split(',').map((s) => s.trim()),
    credentials: true,
  })
);

// Ограничение частоты запросов к аутентификации — защита от подбора пароля/кода 2FA.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Слишком много попыток. Попробуй позже.' },
});
app.use('/api/auth', authLimiter, authRouter);

app.use('/api/me', meRouter);
app.use('/api/transactions', transactionsRouter);
app.use('/api/budgets', budgetsRouter);
app.use('/api/portfolio', portfolioRouter);

app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ── статика: фронтенд FinFlow (public/index.html) ──────────
// Раздаётся с того же домена, что и API, — поэтому CORS не нужен, а httpOnly
// refresh-cookie ходит как same-origin.
app.use(express.static(path.join(__dirname, '..', 'public')));

// ── обработчик ошибок ──────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Внутренняя ошибка сервера' });
});

app.use((req, res) => res.status(404).json({ error: 'Не найдено' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ FinFlow API запущен на порту ${PORT}`);
});
