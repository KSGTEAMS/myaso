# SETUP — локальный запуск, Supabase (секреты, cron) и публикация

Продукт: PWA онлайн-заказов на самовывоз для мясных магазинов. Один общий
JS/CSS-билд и один проект Supabase обслуживают сколько угодно магазинов
(tenant'ов). Магазин описывается файлом `tenants/<slug>/business.json` и папкой
`tenants/<slug>/images/`; после публикации источник правды — база данных.

```
/s/<slug>/            витрина магазина (PWA, scope /s/<slug>/)
/s/<slug>/owner/      кабинет владельца (отдельная PWA, scope /s/<slug>/owner/)
/t/<slug>/…           манифесты, иконки, стартовые экраны, фото (статично)
/                      список опубликованных магазинов (tenants.json)
```

## 1. Архитектура в одном экране

| Слой | Что | Где |
|---|---|---|
| Фронтенд | React 19 + TS strict, Vite, React Router 7, TanStack Query 5, Zod 4, Astryx 0.7 (основные компоненты, тема, i18n ru-RU) + shadcn Drawer (ветка **vaul**) для bottom sheet, Tailwind v4 только как мост к токенам Astryx | `src/` |
| Service worker | `vite-plugin-pwa` injectManifest, один `/sw.js`, регистрируется отдельно на каждый scope; имена кэшей `shop-<slug>-<client\|owner>-*`; кэшируются только статические файлы | `src/sw.ts` |
| БД | Postgres: `tenant_id` + составные FK `(tenant_id, id)`, RLS, строгие GRANT; `resource_occupancies` с `EXCLUDE USING gist` — единая занятость для заказов и блокировок | `supabase/migrations/` |
| Логика | Атомарные SQL-функции: слоты, создание/перенос/отмена заказа, идемпотентность, токены, статистика, outbox, лимиты, бюджет LLM | `supabase/migrations/2026101400050*…0013*` |
| Edge Functions | `public-api` (покупатель, rate limit), `ai-chat` (помощник), `notify-dispatch` (outbox → Web Push) | `supabase/functions/` |
| Конвейер | `tenant:new / validate / publish / verify`, `owner:invite`, `seed:build`, `build-shells` | `scripts/` |
| Хостинг | Cloudflare Pages: `dist/` + `_redirects` (deep links → оболочка нужного магазина) + `_headers` | `scripts/build-shells.ts` |

Модель предметной области: товар (за кг или штуку) → корзина → время выдачи.
Позиции группируются по **профилю подготовки** (разделка, фарш, копчение,
довызревание). Каждая группа занимает **один конкретный подходящий ресурс**
(стол, коптильня, камера) на непрерывный диапазон
`[выдача − (подготовка + буфер), выдача)`. Рабочие часы задают моменты выдачи;
если подготовка короче рабочего окна, она обязана уложиться в часы работы того
же дня, длинная (сутки копчения, 3 дня вызревания) может идти ночью.
Исключения по датам заменяют часы недели. Все расчёты — в часовом поясе магазина.

## 2. Локальный запуск (без Docker)

Нужны: Node ≥ 22, PostgreSQL ≥ 15 с `btree_gist`/`pgcrypto` (contrib), интернет
для однократной загрузки бинарников.

```bash
npm ci
npm run local:install          # PostgREST + Supabase Auth в .local/bin, Deno из npm
# Postgres должен слушать 127.0.0.1:5432, пользователь postgres/postgres
# (переопределяется LOCAL_PG_HOST/PORT/USER/PASSWORD/DB)
npm run local:reset            # БД app_local: роли Supabase, миграции Auth, наши миграции, seed,
                               # демо-владельцы, затем стартуют PostgREST, Auth, Edge Functions, gateway
npm run dev                    # http://localhost:5173/s/rebro/  и  /s/taiga/
```

`local:start` (без `--reset`) переиспользует существующую БД. `local:stop`,
`local:status` — управление процессами; логи в `.local/run/*.log`.

Локальный стек — это настоящие компоненты Supabase (PostgREST, GoTrue/Auth) +
ваши Edge Functions под Deno + gateway с тем же URL-раскладом, что у Supabase
(`/rest/v1`, `/auth/v1`, `/functions/v1`). **Исключение:** `/storage/v1` — это
локальный адаптер (публичное чтение и загрузка с тем же правилом доступа, что
в политиках `storage.objects`), а не Supabase Storage.

Демо-доступы кабинета (только локально, создаются при `local:reset`):

| Магазин | URL | E-mail | Пароль |
|---|---|---|---|
| Ребро (Москва) | `/s/rebro/owner/` | owner@rebro.demo | demo-rebro-owner |
| Тайга (Новосибирск) | `/s/taiga/owner/` | owner@taiga.demo | demo-taiga-owner |

Сборка «как в проде» и e2e:

```bash
npm run build                  # tsc + vite build + оболочки всех магазинов из tenants/registry.json
npm run serve:dist             # http://127.0.0.1:4173 с теми же _redirects/_headers, что у Pages
PW_CHROMIUM_PATH=/path/to/chromium npm run test:e2e   # без переменной — браузер Playwright
```

Тесты:

```bash
npm test                       # unit + SQL integration (создаёт БД app_test)
npm run test:stack             # HTTP через запущенный локальный стек
npm run test:functions         # deno check всех Edge Functions
npm run test:e2e               # Playwright (нужны local:start и build)
```

## 3. Проект Supabase

1. Создайте проект. В **Authentication → Providers → Email** отключите
   регистрацию (Allow new users to sign up = off). Публичной регистрации
   владельцев нет — аккаунты создаёт `owner:invite` с service role.
2. Привяжите и примените миграции:
   ```bash
   npx supabase login
   npx supabase link --project-ref <ref>
   npx supabase db push               # все файлы supabase/migrations
   ```
   Миграция `…001200_storage_cron.sql` создаёт bucket `tenant-media` и политики
   записи только в `<tenant_id>/owner/` для членов магазина, а также задания
   pg_cron (если расширения доступны — на Supabase они есть).
3. **Секреты Edge Functions**:
   ```bash
   npm run vapid:keys                  # VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY
   cat > supabase/functions/.env <<'EOF'
   VAPID_PUBLIC_KEY=...
   VAPID_PRIVATE_KEY=...
   VAPID_SUBJECT=mailto:you@example.com
   CRON_SECRET=<openssl rand -hex 32>
   IP_HASH_SALT=<openssl rand -hex 16>
   ALLOWED_ORIGINS=https://<pages-domain>
   PUBLIC_APP_URL=https://<pages-domain>
   LLM_BASE_URL=https://<openai-compatible>/v1
   LLM_API_KEY=...
   LLM_MODEL=...
   EOF
   npx supabase secrets set --env-file supabase/functions/.env
   npx supabase functions deploy public-api ai-chat notify-dispatch
   ```
   `supabase/functions/.env` в `.gitignore`. Без `LLM_*` помощник отвечает по
   данным SQL-инструментов без модели; заказ от ИИ не зависит никогда.
4. **Cron (outbox уведомлений)**. Задание `notify-dispatch` уже создано
   миграцией и раз в минуту вызывает функцию через `pg_net`. Ему нужны два
   секрета в Vault (SQL Editor):
   ```sql
   select vault.create_secret('https://<ref>.supabase.co', 'project_url');
   select vault.create_secret('<тот же CRON_SECRET>', 'cron_secret');
   -- проверка:
   select jobname, schedule from cron.job;
   select * from cron.job_run_details order by start_time desc limit 5;
   ```
   Функция отвергает вызовы без верного `x-cron-secret`.
5. Если pg_cron был недоступен в момент миграции — включите расширения
   `pg_cron` и `pg_net` в Dashboard → Database → Extensions и выполните блок
   `do $cron$ … $cron$` из миграции `…001200_storage_cron.sql` повторно.

## 4. Публикация магазина

```bash
cp .env.example .env    # заполните SUPABASE_URL / SUPABASE_*_KEY / PUBLIC_APP_URL / CLOUDFLARE_*
npm run tenant:validate -- rebro
npm run tenant:publish -- rebro --invite-owner --demo     # preview + владелец + демо-данные
npm run tenant:publish -- rebro --live                    # проверка готовности на сервере, демо удаляется
npm run tenant:publish -- rebro --deploy                  # сборка и загрузка на Cloudflare Pages
npm run tenant:verify -- rebro --site https://<pages-domain>
```

* **Preview** — магазин виден по ссылке, заказы помечаются `is_demo`,
  уведомления создаются со статусом `skipped`.
* **Live** включается только если `tenant_readiness` не нашёл проблем
  (активные товары, у каждого есть активный ресурс, часы работы, телефон,
  адрес, владелец, есть моменты выдачи в горизонте). При переходе в live все
  демо-заказы и демо-платежи удаляются.
* Повторная публикация обновляет каталог/часы/ресурсы, но **сохраняет заказы и
  фото, загруженные владельцем** (`image_source = 'owner'`). Удалённые из
  JSON товары/ресурсы деактивируются, а не удаляются.
* `tenants/registry.json` накапливает все опубликованные магазины; каждая
  сборка генерирует оболочки для всех — новый магазин не заменяет прежние.

### Cloudflare Pages

* Build command: `npm ci && npm run build`, output: `dist`, Node 22.
* Переменные окружения сборки: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`,
  `VITE_VAPID_PUBLIC_KEY`.
* `dist/_redirects` отдаёт для любого `/s/:slug/*` оболочку именно этого
  магазина, `/s/:slug/owner/*` — оболочку кабинета. `dist/_headers` выставляет
  `no-cache` для `sw.js` и оболочек и `immutable` для `/assets/*`.

## 5. Безопасность — что где проверяется

* Клиент присылает только `slug`, `product_id`+количество, момент выдачи и
  контакты. Цена, длительность, ресурс и tenant вычисляются в SQL.
* Доступ покупателя к заказу — 256-битный токен (HMAC от id заказа и ключа
  идемпотентности серверным секретом). В БД — только SHA-256. Повтор запроса
  с тем же ключом возвращает тот же заказ и тот же токен. Токен в ссылке
  передаётся во фрагменте `#t=…` (не попадает в логи сервера).
* Владелец: Supabase Auth + строка в `tenant_members`; каждая `owner_*`
  функция заново проверяет членство по `auth.uid()`.
* `anon` не может читать заказы, позиции, платежи, подписки, outbox, ключи
  идемпотентности; не может выполнять серверные функции. `access_token_hash`
  не выдаётся даже владельцу.
* Публичные запросы и бюджет LLM ограничены атомарными счётчиками в Postgres
  (общими для всех инстансов функций).
* При выходе из кабинета удаляются сессия, приватный кэш запросов, подписка
  push этого устройства и runtime-кэши scope кабинета; API-ответы service
  worker не кэширует никогда.

## 6. Как подключён Astryx

```bash
npm i @astryxdesign/core@0.7.0 @stylexjs/stylex @astryxdesign/theme-neutral@0.7.0
npm i -D @astryxdesign/cli@0.7.0
npx astryx init --all          # AGENTS.md + theme.template.ts
npx astryx theme add neutral   # генерирует src/astryx-themes.ts
npx astryx component <Name>    # props каждого компонента перед использованием
```

* Порядок слоёв объявлен первым импортом (`src/styles/layers.css`):
  `reset, theme, base, astryx-base, astryx-theme, components, utilities`.
  Foundation smoke test (padding кнопки ≠ 0) проходит.
* Акцент магазина применяется в рантайме через документированный
  `defineTheme({ extends, color: { accent } })` + `--color-on-accent`.
* shadcn-классы (`bg-background`, `text-muted-foreground` …) отображены на
  токены Astryx в `src/styles/app.css` — один набор токенов на обе библиотеки.
* Drawer: только ветка **vaul** (`registry/new-york-v4/ui/drawer.tsx`), без
  Base UI.
