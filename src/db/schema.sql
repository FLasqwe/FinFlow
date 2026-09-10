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

-- ── Подписка (тариф Pro) ─────────────────────────────────────
-- Pro активен, пока pro_until в будущем. «Навсегда» = дата далеко вперёд (2099).
ALTER TABLE users ADD COLUMN IF NOT EXISTS pro_until      TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS pro_source     TEXT;    -- 'promo' | 'manual' | платёжный провайдер
ALTER TABLE users ADD COLUMN IF NOT EXISTS promo_discount INTEGER; -- % скидки на будущую оплату (из percent-кода)

CREATE TABLE IF NOT EXISTS promo_codes (
  code        TEXT PRIMARY KEY,                       -- хранится в верхнем регистре
  kind        TEXT NOT NULL CHECK (kind IN ('free_days','free_forever','percent')),
  value       INTEGER,                                -- free_days: дней; percent: %; free_forever: NULL
  max_uses    INTEGER,                                -- NULL — без лимита
  used_count  INTEGER NOT NULL DEFAULT 0,
  expires_at  TIMESTAMPTZ,                            -- срок годности самого кода
  active      BOOLEAN NOT NULL DEFAULT true,
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS promo_redemptions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code        TEXT NOT NULL REFERENCES promo_codes(code) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (code, user_id)                              -- один код — один раз на пользователя
);
