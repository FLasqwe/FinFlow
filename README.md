# FinFlow Backend

Backend API для приложения FinFlow: синхронизация транзакций, бюджетов и портфеля
активов между устройствами. Node.js + Express + PostgreSQL.

Это отдельный проект от HTML-версии приложения (той, что открывается локально в
браузере и хранит всё в `localStorage`). Он даёт то, что нельзя сделать внутри
одного статического файла: реальную базу данных, серверную аутентификацию с
bcrypt и JWT, и настоящую (RFC 6238) двухфакторную аутентификацию, совместимую с
Google Authenticator и аналогами.

## Что уже есть

- Регистрация/вход по email+паролю (bcrypt, 12 раундов)
- JWT access-токены (15 минут) + refresh-токены в httpOnly cookie с ротацией
- Настоящая 2FA (TOTP) с QR-кодом для приложений-аутентификаторов
- CRUD для транзакций, бюджетов, портфеля (крипта/металлы/валюта/акции с историей покупок-лотов)
- Профиль пользователя: валюта, тема, акцентный цвет, конфигурация виджетов дашборда
- Rate limiting на маршрутах аутентификации
- Docker Compose для запуска одной командой локально

## Чего здесь нет (следующие шаги)

- **Сам фронтенд не подключён к этому API.** HTML-версия приложения по-прежнему
  использует `localStorage`. Чтобы данные реально синхронизировались между
  устройствами, часть функций во фронтенде (`getTx/saveTx`, `getBudgets/...`,
  `getPortfolio/savePortfolio`, вход/регистрация) нужно переписать на вызовы
  этого API вместо localStorage. Формы данных (поля транзакций, холдингов и
  т.п.) уже специально сделаны максимально похожими на фронтенд, чтобы это
  было прямолинейной заменой.
- Загрузка фото профиля хранится как `photo_url` (ссылка), но самого файлового
  хранилища (S3/Cloudinary/локальная папка) здесь нет — если понадобится,
  добавляется отдельно.
- Email-подтверждение регистрации, сброс пароля по почте — не реализовано.

## Стек

Express, PostgreSQL (`pg`), bcryptjs, jsonwebtoken, otplib (TOTP), zod
(валидация), helmet, express-rate-limit.

## Быстрый старт (Docker, рекомендуется)

Требуется только Docker и Docker Compose.

```bash
cp .env.example .env
# пароли/секреты в .env можно оставить дефолтными для локальной разработки —
# для продакшена сгенерируй свои (см. .env.example)

docker compose up --build
```

После первого запуска БД пустая — примени схему:

```bash
docker compose exec api npm run migrate
```

API поднимется на `http://localhost:3000`. Проверить:

```bash
curl http://localhost:3000/api/health
# {"ok":true,"time":"..."}
```

## Запуск без Docker (локальный Node + своя Postgres)

1. Установи Node.js 18+ и PostgreSQL 14+.
2. Создай базу данных:
   ```sql
   CREATE DATABASE finflow;
   ```
3. Установи зависимости и настрой окружение:
   ```bash
   npm install
   cp .env.example .env
   # впиши в .env свою DATABASE_URL и сгенерируй секреты:
   node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
   ```
4. Примени схему БД:
   ```bash
   npm run migrate
   ```
5. Запусти сервер:
   ```bash
   npm start
   # для разработки с автоперезапуском: npm run dev
   ```

## Деплой в облако

Проект — обычное Node-приложение + Postgres, подходит для любого хостинга.
Самый быстрый путь — один из managed-провайдеров с бесплатным тиром:

### Railway
1. Создай новый проект → "Deploy from GitHub repo" (залей эту папку в свой репозиторий) или "Empty project".
2. Добавь плагин **PostgreSQL** — Railway сам создаст `DATABASE_URL` и подставит в переменные окружения сервиса.
3. В переменных окружения сервиса добавь `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `ALLOWED_ORIGIN`, `NODE_ENV=production`.
4. Command для миграции один раз после деплоя: `npm run migrate` (через Railway CLI: `railway run npm run migrate`).
5. Start command: `npm start`.

### Render
1. "New Web Service" → подключи репозиторий.
2. Build command: `npm install`. Start command: `npm start`.
3. "New PostgreSQL" → скопируй Internal Database URL в переменную `DATABASE_URL` веб-сервиса.
4. Добавь остальные переменные из `.env.example`.
5. В Shell вкладке сервиса один раз выполни `npm run migrate`.

### Fly.io / собственный VPS
Используй `Dockerfile` из проекта: `fly launch`, подключи Fly Postgres или
внешнюю БД через `DATABASE_URL`, задеплой `fly deploy`, затем
`fly ssh console -C "npm run migrate"`.

Во всех случаях: **HTTPS обязателен в продакшене** — `NODE_ENV=production`
включает secure-cookie для refresh-токена, которая браузер не отправит по
обычному http.

## Обзор API

Все маршруты (кроме `/api/auth/*` и `/api/health`) требуют заголовок
`Authorization: Bearer <accessToken>`, полученный при входе.

### Аутентификация
| Метод | Путь | Описание |
|---|---|---|
| POST | `/api/auth/register` | `{email,password,name,surname?}` → `{accessToken,user}` |
| POST | `/api/auth/login` | `{email,password}` → `{accessToken,user}` либо `{requires2FA:true,tempToken}` |
| POST | `/api/auth/2fa/verify` | `{tempToken,code}` → `{accessToken,user}` |
| POST | `/api/auth/refresh` | по refresh-cookie → новый `{accessToken,user}` |
| POST | `/api/auth/logout` | завершает текущую сессию (сбрасывает refresh-cookie) |

### Профиль
| Метод | Путь | Описание |
|---|---|---|
| GET | `/api/me` | текущий профиль |
| PATCH | `/api/me` | обновить любые поля профиля (валюта, тема, акцент, виджеты...) |
| POST | `/api/me/password` | `{oldPassword,newPassword}` |
| POST | `/api/me/2fa/setup` | → `{secret,otpauthUrl,qrDataUrl}` |
| POST | `/api/me/2fa/enable` | `{code}` — подтвердить и включить 2FA |
| POST | `/api/me/2fa/disable` | `{code}` |

### Транзакции
| Метод | Путь | Описание |
|---|---|---|
| GET | `/api/transactions?year=&month=` | список (без параметров — вся история) |
| POST | `/api/transactions` | `{type,amount,category,note?,date}` |
| DELETE | `/api/transactions/:id` | удалить одну |
| DELETE | `/api/transactions` | удалить всю историю |

### Бюджеты
| Метод | Путь | Описание |
|---|---|---|
| GET | `/api/budgets` | `{category: amount, ...}` |
| PUT | `/api/budgets` | заменить целиком тем же форматом |

### Портфель
| Метод | Путь | Описание |
|---|---|---|
| GET | `/api/portfolio` | все активы с историей покупок |
| POST | `/api/portfolio/holdings` | создать актив + первую покупку |
| POST | `/api/portfolio/holdings/:id/lots` | докупить (новый лот) |
| PATCH | `/api/portfolio/holdings/:id/price` | вручную обновить цену (для акций) |
| DELETE | `/api/portfolio/lots/:id` | удалить одну покупку |
| DELETE | `/api/portfolio/holdings/:id` | удалить актив целиком |

## Безопасность

- Пароли хранятся только как bcrypt-хэш, никогда в открытом виде.
- Refresh-токены хранятся в БД тоже только как хэш (SHA-256); сам токен живёт
  исключительно в httpOnly cookie браузера.
- Access и refresh токены используют разные секреты.
- Refresh-токен ротируется при каждом обновлении — использование однажды
  скомпрометированного токена сразу становится заметным (старый токен перестаёт
  работать).
- 2FA — стандартный TOTP (RFC 6238), не самодельная имитация.
- Rate limiting на `/api/auth/*` — 30 запросов за 15 минут с одного IP.
