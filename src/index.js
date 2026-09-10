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
const recurringRouter = require('./routes/recurring');
const billingRouter = require('./routes/billing');
const accountsRouter = require('./routes/accounts');
const adminRouter = require('./routes/admin');
const goalsRouter = require('./routes/goals');
const supportRouter = require('./routes/support');
const simRouter = require('./routes/sim');

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
app.use('/api/recurring', recurringRouter);
app.use('/api/billing', billingRouter);
app.use('/api/accounts', accountsRouter);
app.use('/api/admin', adminRouter);
app.use('/api/goals', goalsRouter);
app.use('/api/support', supportRouter);
app.use('/api/sim', simRouter);

app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ── статика: фронтенд FinFlow + PWA (public/) ─────────────
// Раздаётся с того же домена, что и API, — поэтому CORS не нужен, а httpOnly
// refresh-cookie ходит как same-origin.
app.use(
  express.static(path.join(__dirname, '..', 'public'), {
    setHeaders(res, filePath) {
      const base = path.basename(filePath);
      if (base === 'sw.js' || base === 'index.html') {
        // service worker и оболочку не кэшируем на уровне HTTP — иначе обновления не доедут
        res.setHeader('Cache-Control', 'no-cache');
      } else if (filePath.includes(`${path.sep}icons${path.sep}`)) {
        res.setHeader('Cache-Control', 'public, max-age=86400');
      } else if (base === 'manifest.webmanifest') {
        res.setHeader('Cache-Control', 'public, max-age=3600');
      }
    },
  })
);

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
