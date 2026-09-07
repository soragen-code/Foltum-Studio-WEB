# Foltum Studio WEB — Требования для запуска проекта

> Анализ ветки `main` (после мержа PR #1). Репозиторий: https://github.com/soragen-code/Foltum-Studio-WEB

## 1. Стек технологий

| Компонент | Версия / Технология |
|---|---|
| Framework | **Next.js 16.3.3** (App Router, сборка через webpack) |
| Язык | TypeScript 5.6.3 |
| UI | React 19.2.8, Radix UI, Tailwind CSS 3.4, framer-motion, lucide-react |
| ORM | **Prisma 6.7.0** |
| БД | **PostgreSQL** |
| Auth | **NextAuth v5** (`5.0.0-beta.32`) + `@auth/prisma-adapter`, стратегия JWT, провайдер Credentials (email+пароль, bcrypt) |
| Хранилище файлов | **AWS S3** (`@aws-sdk/client-s3`, presigned URLs, multipart upload) |
| Node.js | `>=20.9.0` |
| Менеджер пакетов | npm (используется `.npmrc` с `legacy-peer-deps=true`) |

### npm scripts
```
dev         → next dev
build       → prisma generate && next build --webpack
start       → next start
lint        → eslint .
postinstall → prisma generate
prisma.seed → tsx --require dotenv/config scripts/safe-seed.ts
```

---

## 2. Переменные окружения (ENV)

### Обязательные (без них проект не работает)

| Переменная | Назначение | Пример / формат |
|---|---|---|
| `DATABASE_URL` | Строка подключения к PostgreSQL (используется Prisma) | `postgresql://user:pass@host:5432/dbname?connect_timeout=15` |
| `AUTH_SECRET` | Секрет для подписи сессий/JWT (NextAuth v5 читает именно `AUTH_SECRET`) | случайная строка ≥32 симв. (`openssl rand -base64 32`) |
| `NEXTAUTH_SECRET` | Тот же секрет — оставлен для совместимости; задать таким же значением | случайная строка |

### Обязательные для загрузки файлов (AWS S3)

| Переменная | Назначение |
|---|---|
| `AWS_BUCKET_NAME` | Имя S3-бакета для загрузки медиа |
| `AWS_REGION` | Регион бакета (по умолчанию в коде `us-west-2`) |
| `AWS_FOLDER_PREFIX` | Префикс-папка внутри бакета (напр. `77873/`) |
| `AWS_ACCESS_KEY_ID` | Ключ доступа AWS* |
| `AWS_SECRET_ACCESS_KEY` | Секретный ключ AWS* |
| `AWS_PROFILE` | (Альтернатива ключам) имя профиля из `~/.aws/credentials` |

> \* `createS3Client()` вызывается как `new S3Client({})` — без явных креденшелов, поэтому SDK берёт их из стандартной цепочки: переменные `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`, либо `AWS_PROFILE`, либо IAM-роль. На Vercel профиль недоступен — нужны именно `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`.

### Опциональные / контекстные

| Переменная | Назначение |
|---|---|
| `NEXTAUTH_URL` | Базовый URL приложения. В NextAuth v5 не строго обязателен (`trustHost: true` в `auth.ts`), но рекомендуется в проде: `https://<домен>` |
| `AUTH_SMOKE_BASE` | Только для скрипта `scripts/auth-smoke.mjs` (dev/тесты) |
| `PORT`, `NODE_ENV`, `NEXT_DIST_DIR`, `NEXT_OUTPUT_MODE` | Служебные, задаются рантаймом/хостингом |

### ⚠️ Про `ABACUSAI_API_KEY`
В исходном `.env` был ключ `ABACUSAI_API_KEY`, но **в коде он сейчас не используется**. AI-роуты (`/api/ai/*`) — это **заглушки (STUB)**: синопсис/структура/сцены генерируют захардкоженный текст, а изображения/видео возвращают placeholder-картинки (`placehold.co`). Ключ понадобится, когда заглушки заменят на реальную интеграцию LLM/видео-генерации.

---

## 3. База данных

- **Тип:** PostgreSQL.
- **Подключение:** через `DATABASE_URL`.
- **Инициализация:** `prisma generate` (уже в `postinstall`/`build`) + для создания таблиц нужно применить схему:
  - `npx prisma migrate deploy` (если есть миграции) или `npx prisma db push` (создать таблицы из схемы напрямую).
  - Опциональный сид: `npx prisma db seed` (защищён `safe-seed.ts` — запрещает delete/deleteMany).
- **Модели (10):** `User`, `Account`, `Session`, `VerificationToken` (стандарт NextAuth), `Project`, `Character`, `Season`, `Episode`, `Scene`, `SceneCharacter`, `CreditTransaction`.
- **Доменная логика:** пользователи с кредитами (`credits`, дефолт 100) и подпиской (`subscriptionTier`); проекты проходят стадии `synopsis → characters → structure → scenes`; иерархия контента Project → Season → Episode → Scene, персонажи связаны со сценами через `SceneCharacter`.

---

## 4. Внешние сервисы

| Сервис | Для чего | Обязателен? |
|---|---|---|
| **PostgreSQL** | Основная БД | ✅ Да |
| **AWS S3** | Хранение загружаемых файлов, изображений персонажей, видео (presigned upload/download, multipart) | ✅ Да (для загрузок/медиа) |
| **AWS IAM** | Креденшелы для доступа к S3 | ✅ Да (вместе с S3) |
| LLM / видео-генерация (напр. Abacus.AI / GPT-4o) | Реальная генерация синопсиса, персонажей, сцен, видео | ⏳ Пока нет (роуты — заглушки) |

> В `package.json` присутствует `@azure/storage-blob`, но в коде (`lib/`) он не используется — активное хранилище только AWS S3.

---

## 5. Маршруты приложения

### Страницы (UI)
| Путь | Файл |
|---|---|
| `/` | `app/page.tsx` (лендинг; редиректит неавторизованных на `/login`) |
| `/login` | `app/login/page.tsx` |
| `/signup` | `app/signup/page.tsx` |
| `/dashboard` | `app/dashboard/page.tsx` |
| `/pricing` | `app/pricing/page.tsx` |
| `/project/new` | `app/project/new/page.tsx` |
| `/project/[id]` | `app/project/[id]/page.tsx` (мастер: синопсис → персонажи → структура → сцены) |

### API-роуты
| Метод/Путь | Назначение |
|---|---|
| `/api/auth/[...nextauth]` | NextAuth обработчики (вход/сессии) |
| `/api/auth/login` | Логин |
| `/api/signup` | Регистрация пользователя |
| `/api/user/credits` | Баланс кредитов пользователя |
| `/api/credits/add` | Пополнение кредитов |
| `/api/projects` | Список / создание проектов |
| `/api/projects/[id]` | Получить / изменить проект |
| `/api/projects/[id]/approve-synopsis` | Утвердить синопсис |
| `/api/projects/[id]/lock-characters` | Зафиксировать персонажей |
| `/api/projects/[id]/approve-structure` | Утвердить структуру |
| `/api/upload/presigned` | Получить presigned URL для загрузки в S3 |
| `/api/ai/synopsis` | (STUB) генерация синопсиса |
| `/api/ai/characters` | (STUB) генерация персонажей |
| `/api/ai/characters/regenerate` | (STUB) перегенерация персонажа |
| `/api/ai/structure` | (STUB) генерация структуры сезонов/эпизодов |
| `/api/ai/scenes` | (STUB) генерация сцен |
| `/api/ai/accept-scene` | Принять сцену |
| `/api/ai/generate-video` | (STUB) генерация видео сцены (placeholder) |
| `/api/ai/assemble-episode` | (STUB) сборка эпизода (placeholder) |

---

## 6. Чек-лист для полноценного запуска

1. **PostgreSQL** — поднять БД, получить `DATABASE_URL`.
2. **Применить схему**: `npx prisma db push` (или `migrate deploy`).
3. **AWS S3** — создать бакет, IAM-пользователя с правами на бакет, задать `AWS_BUCKET_NAME`, `AWS_REGION`, `AWS_FOLDER_PREFIX`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`.
4. **Секреты auth** — сгенерировать `AUTH_SECRET` (и продублировать в `NEXTAUTH_SECRET`).
5. **`NEXTAUTH_URL`** — указать публичный URL в проде.
6. `npm install` (подтянет зависимости, `postinstall` сгенерирует Prisma Client) → `npm run build` → `npm start`.
7. (Позже) Заменить STUB-роуты `/api/ai/*` на реальную интеграцию LLM/видео и добавить соответствующий API-ключ (`ABACUSAI_API_KEY` или иной).

> Файл `.env.example` в репозитории отсутствует — ниже готовый шаблон, который можно сохранить как `.env`.

```dotenv
# --- Database ---
DATABASE_URL="postgresql://user:password@host:5432/dbname?connect_timeout=15"

# --- Auth (NextAuth v5) ---
AUTH_SECRET="<openssl rand -base64 32>"
NEXTAUTH_SECRET="<то же значение, что и AUTH_SECRET>"
NEXTAUTH_URL="https://your-domain.com"

# --- AWS S3 ---
AWS_BUCKET_NAME="your-bucket"
AWS_REGION="us-west-2"
AWS_FOLDER_PREFIX="your-prefix/"
AWS_ACCESS_KEY_ID="..."
AWS_SECRET_ACCESS_KEY="..."

# --- (опционально, когда AI-роуты перестанут быть заглушками) ---
# ABACUSAI_API_KEY="..."
```
