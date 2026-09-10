-- FinFlow — схема базы данных PostgreSQL
-- Применяется автоматически через `npm run migrate` (см. src/db/migrate.js)

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email             TEXT UNIQUE NOT NULL,
  password_hash     TEXT NOT NULL,
  name              TEXT NOT NULL,
  surname           TEXT,
  avatar            TEXT,             -- emoji-аватар
  photo_url         TEXT,             -- URL загруженного фото (если используется файловое хранилище)
  currency          TEXT NOT NULL DEFAULT 'RUB',
  theme             TEXT NOT NULL DEFAULT 'dark',
  accent_hue        INTEGER NOT NULL DEFAULT 252,
  dashboard_widgets JSONB,            -- [{id,visible}, ...] — порядок и видимость виджетов дашборда
  totp_enabled      BOOLEAN NOT NULL DEFAULT false,
  totp_secret       TEXT,             -- секрет генерируется при /me/2fa/setup, сохраняется только после /enable
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL,          -- хранится только хэш refresh-токена, не сам токен
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_refresh_user ON refresh_tokens(user_id);

CREATE TABLE IF NOT EXISTS transactions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        TEXT NOT NULL CHECK (type IN ('income','expense')),
  amount      NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  category    TEXT NOT NULL,
  note        TEXT,
  date        DATE NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tx_user_date ON transactions(user_id, date DESC);

CREATE TABLE IF NOT EXISTS budgets (
  user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category  TEXT NOT NULL,
  amount    NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  PRIMARY KEY (user_id, category)
);

CREATE TABLE IF NOT EXISTS portfolio_holdings (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type              TEXT NOT NULL CHECK (type IN ('crypto','metal','currency','stock')),
  asset_id          TEXT NOT NULL,     -- 'BTC', 'XAU', 'USD', тикер акции...
  name              TEXT NOT NULL,
  sym               TEXT NOT NULL,
  icon              TEXT,
  color             TEXT,
  manual_price      NUMERIC(18,6),     -- только для type='stock' — цену обновляет пользователь вручную
  manual_price_cur  TEXT,
  manual_price_ts   TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, type, asset_id)
);

CREATE TABLE IF NOT EXISTS portfolio_lots (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  holding_id  UUID NOT NULL REFERENCES portfolio_holdings(id) ON DELETE CASCADE,
  qty         NUMERIC(24,8) NOT NULL CHECK (qty > 0),
  price       NUMERIC(18,6) NOT NULL CHECK (price >= 0),
  currency    TEXT NOT NULL,          -- валюта, в которой указана цена лота
  date        DATE NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_lots_holding ON portfolio_lots(holding_id);

-- Регулярные транзакции: правило, по которому периодически создаются обычные транзакции.
CREATE TABLE IF NOT EXISTS recurring_rules (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type          TEXT NOT NULL CHECK (type IN ('income','expense')),
  amount        NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  category      TEXT NOT NULL,
  note          TEXT,
  cadence       TEXT NOT NULL CHECK (cadence IN ('weekly','monthly','yearly')),
  day_of_month  INTEGER CHECK (day_of_month BETWEEN 1 AND 31),   -- для monthly/yearly
  day_of_week   INTEGER CHECK (day_of_week BETWEEN 0 AND 6),     -- для weekly (0 = воскресенье)
  month_of_year INTEGER CHECK (month_of_year BETWEEN 1 AND 12),  -- для yearly
  start_date    DATE NOT NULL,
  end_date      DATE,
  last_run      DATE,                 -- по какую дату уже созданы вхождения
  active        BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_recurring_user ON recurring_rules(user_id);

-- Ссылка транзакции на правило, которое её породило (NULL — создана вручную).
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS recurring_id UUID
  REFERENCES recurring_rules(id) ON DELETE SET NULL;

-- ── Подписка (тарифы free / pro / premium / business) ───────
-- Тариф активен, пока tier_until в будущем. «Навсегда» = дата далеко вперёд (2099).
ALTER TABLE users ADD COLUMN IF NOT EXISTS pro_until      TIMESTAMPTZ;  -- legacy, не используется
ALTER TABLE users ADD COLUMN IF NOT EXISTS pro_source     TEXT;         -- legacy
ALTER TABLE users ADD COLUMN IF NOT EXISTS promo_discount INTEGER;      -- % скидки на будущую оплату (percent-код)
ALTER TABLE users ADD COLUMN IF NOT EXISTS tier           TEXT NOT NULL DEFAULT 'free';
ALTER TABLE users ADD COLUMN IF NOT EXISTS tier_until     TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS tier_source    TEXT;         -- 'promo' | 'manual' | платёжный провайдер
-- перенос со старой бинарной модели pro_until → tier
UPDATE users SET tier='pro', tier_until=pro_until, tier_source=COALESCE(pro_source,'manual')
  WHERE tier='free' AND pro_until IS NOT NULL AND pro_until > now();

CREATE TABLE IF NOT EXISTS promo_codes (
  code        TEXT PRIMARY KEY,                       -- хранится в верхнем регистре
  kind        TEXT NOT NULL CHECK (kind IN ('free_days','free_forever','percent')),
  grants_tier TEXT NOT NULL DEFAULT 'pro' CHECK (grants_tier IN ('pro','premium','business')),
  value       INTEGER,                                -- free_days: дней; percent: %; free_forever: NULL
  max_uses    INTEGER,                                -- NULL — без лимита
  used_count  INTEGER NOT NULL DEFAULT 0,
  expires_at  TIMESTAMPTZ,                            -- срок годности самого кода
  active      BOOLEAN NOT NULL DEFAULT true,
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE promo_codes ADD COLUMN IF NOT EXISTS grants_tier TEXT NOT NULL DEFAULT 'pro';

CREATE TABLE IF NOT EXISTS promo_redemptions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code        TEXT NOT NULL REFERENCES promo_codes(code) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (code, user_id)                              -- один код — один раз на пользователя
);

-- ── Счета и карты ────────────────────────────────────────────
-- Баланс счёта = start_balance + Σ(доходы по счёту) − Σ(расходы по счёту).
CREATE TABLE IF NOT EXISTS accounts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'cash' CHECK (kind IN ('card','cash','bank','savings','crypto','other')),
  currency      TEXT NOT NULL DEFAULT 'RUB',
  start_balance NUMERIC(18,2) NOT NULL DEFAULT 0,
  icon          TEXT,
  color         TEXT,
  archived      BOOLEAN NOT NULL DEFAULT false,
  sort          INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_accounts_user ON accounts(user_id);

-- Привязка транзакции к счёту (NULL — не привязана; подхватится дефолтным счётом).
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS account_id UUID
  REFERENCES accounts(id) ON DELETE SET NULL;
-- Обе половины перевода между счетами делят transfer_id (для будущих переводов).
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS transfer_id UUID;

-- С какого счёта регулярное правило создаёт транзакции (NULL — дефолтный счёт).
ALTER TABLE recurring_rules ADD COLUMN IF NOT EXISTS account_id UUID
  REFERENCES accounts(id) ON DELETE SET NULL;

-- ── Наблюдаемость: последний вход и журнал событий (для админ-панели) ──
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen TIMESTAMPTZ;

-- Watchlist: отслеживаемые монеты (массив id вроде ["BTC","ETH"]).
ALTER TABLE users ADD COLUMN IF NOT EXISTS watchlist JSONB;

CREATE TABLE IF NOT EXISTS events (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  type       TEXT NOT NULL,        -- register | login | login_2fa | 2fa_enable | promo_redeem | account_create | tier_change | email_verified
  meta       JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at DESC);

-- ── Подтверждение почты ──────────────────────────────────────
-- Существующие юзеры считаются подтверждёнными (DEFAULT true); при регистрации
-- новым явно ставится false.
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS email_codes (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose    TEXT NOT NULL DEFAULT 'verify',   -- verify (позже: reset)
  code_hash  TEXT NOT NULL,                    -- SHA-256 от 6-значного кода
  expires_at TIMESTAMPTZ NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_email_codes_user ON email_codes(user_id, purpose);

-- ── Поддержка: чат с ботом + эскалация на человека ─────────
CREATE TABLE IF NOT EXISTS support_threads (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status       TEXT NOT NULL DEFAULT 'bot' CHECK (status IN ('bot','waiting_human','answered','closed')),
  needs_human  BOOLEAN NOT NULL DEFAULT false,
  last_message_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_support_threads_user ON support_threads(user_id);

CREATE TABLE IF NOT EXISTS support_messages (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id  UUID NOT NULL REFERENCES support_threads(id) ON DELETE CASCADE,
  sender     TEXT NOT NULL CHECK (sender IN ('user','bot','admin')),
  body       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_support_messages_thread ON support_messages(thread_id, created_at);

-- ── Крипто-кошельки: просмотр баланса по адресу (read-only) ──
-- Никаких приватных ключей. Баланс тянется из публичных эксплореров и кэшируется.
CREATE TABLE IF NOT EXISTS wallets (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chain        TEXT NOT NULL CHECK (chain IN ('BTC','ETH','TON')),
  address      TEXT NOT NULL,
  label        TEXT,
  last_native  NUMERIC(40,18),          -- баланс в единицах сети (BTC / ETH / TON)
  last_usd     NUMERIC(20,2),           -- оценка в USD на момент синхронизации
  last_price   NUMERIC(20,8),           -- курс монеты на момент синхронизации
  last_sync    TIMESTAMPTZ,
  sync_error   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, chain, address)
);
CREATE INDEX IF NOT EXISTS idx_wallets_user ON wallets(user_id);

-- ── Симулятор торговли (бумажные деньги, реальные котировки) ──
CREATE TABLE IF NOT EXISTS sim_accounts (
  user_id     UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  cash        NUMERIC(20,2) NOT NULL DEFAULT 10000,
  start_cash  NUMERIC(20,2) NOT NULL DEFAULT 10000,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  reset_at    TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS sim_positions (
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  coin        TEXT NOT NULL,
  qty         NUMERIC(30,10) NOT NULL,
  avg_price   NUMERIC(20,8) NOT NULL,
  PRIMARY KEY (user_id, coin)
);
CREATE TABLE IF NOT EXISTS sim_trades (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  coin        TEXT NOT NULL,
  side        TEXT NOT NULL CHECK (side IN ('buy','sell')),
  qty         NUMERIC(30,10) NOT NULL,
  price       NUMERIC(20,8) NOT NULL,
  usd         NUMERIC(20,2) NOT NULL,
  pnl         NUMERIC(20,2),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sim_trades_user ON sim_trades(user_id, created_at DESC);

-- ── Цели накоплений (тариф Premium) ─────────────────────────
CREATE TABLE IF NOT EXISTS goals (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  target      NUMERIC(18,2) NOT NULL CHECK (target > 0),
  saved       NUMERIC(18,2) NOT NULL DEFAULT 0,   -- накоплено (сумма пополнений)
  deadline    DATE,
  icon        TEXT,
  color       TEXT,
  account_id  UUID REFERENCES accounts(id) ON DELETE SET NULL,
  archived    BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_goals_user ON goals(user_id);

-- ── Ручные активы для картины капитала (наличные, металлы, недвижимость…) ──
-- Всё, что не заводится как счёт / кошелёк / позиция портфеля. Значение вводит
-- и обновляет пользователь вручную, в указанной валюте.
CREATE TABLE IF NOT EXISTS assets (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  class       TEXT NOT NULL DEFAULT 'other'
              CHECK (class IN ('cash','crypto','stocks','metals','realestate','business','other')),
  value       NUMERIC(20,2) NOT NULL DEFAULT 0,
  currency    TEXT NOT NULL DEFAULT 'USD',
  note        TEXT,
  icon        TEXT,
  archived    BOOLEAN NOT NULL DEFAULT false,
  sort        INTEGER NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_assets_user ON assets(user_id);

-- ── Снимки чистого капитала (по одному на день, для графика динамики) ──
-- Считает и присылает фронтенд (там вся логика курсов/конвертации);
-- сервер хранит дневной upsert.
CREATE TABLE IF NOT EXISTS networth_snapshots (
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day        DATE NOT NULL DEFAULT CURRENT_DATE,
  total      NUMERIC(20,2) NOT NULL,
  currency   TEXT NOT NULL DEFAULT 'USD',
  breakdown  JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, day)
);

-- ── Уведомления пользователя (просадка капитала, новый максимум и т.п.) ──
CREATE TABLE IF NOT EXISTS alerts (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,
  title      TEXT NOT NULL,
  body       TEXT,
  meta       JSONB,
  read       BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_alerts_user ON alerts(user_id, created_at DESC);

-- Порог оповещения о просадке чистого капитала, % (0 = выключено).
ALTER TABLE users ADD COLUMN IF NOT EXISTS nw_alert_pct NUMERIC(5,2) NOT NULL DEFAULT 10;
-- Когда планировщик последний раз авто-обновлял кошельки этого пользователя.
ALTER TABLE users ADD COLUMN IF NOT EXISTS wallets_synced_at TIMESTAMPTZ;
