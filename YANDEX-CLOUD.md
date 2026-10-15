# Сайт в Яндекс Облаке — одна виртуальная машина

Вся платформа работает на одной ВМ в регионе ru-central1. Данные покупателей
хранятся в России (152-ФЗ).

```
                 https://shop.example.ru
                          │
                  ┌───────▼────────┐  Caddy: HTTPS (Let's Encrypt), один домен
                  │     Caddy      │
                  └──┬──────────┬──┘
     /rest /auth /functions     │  всё остальное: сайт магазинов (dist/)
     /storage                   │  /s/<магазин>/…  → оболочка этого магазина
                  ┌──▼───────┐  │
                  │ Supabase │  └── /srv/site
                  │ self-host│      Postgres 17 + pg_cron + Vault, Auth, PostgREST,
                  └──────────┘      Storage, Edge Functions (официальный docker, v0.8.2)
```

Всё делает скрипт `deploy/yandex/app.sh`. Node на сервере не нужен:
сборка и скрипты запускаются в одноразовом контейнере.

> **Проверено** 2026-10-14: `app.sh install` → официальный self-hosted
> Supabase v0.8.2 → наши 13 миграций → публикация магазинов → сборка сайта →
> Caddy. Пройдены все 4 Playwright-сценария, `tenant:verify` 26/26 для обоих
> магазинов, политики Storage, цепочка pg_cron → Vault → pg_net →
> notify-dispatch, повторный `update`, `backup`. Не проверено: реальная ВМ
> Яндекса, выпуск HTTPS-сертификата на настоящем домене, YandexGPT
> (см. ACCEPTANCE.md §4).

## 1. Что нужно

* Аккаунт в Яндекс Облаке с платёжным аккаунтом (есть стартовый грант).
* Домен, например `shop.example.ru`, и доступ к его DNS (можно делегировать в
  Cloud DNS Яндекса или оставить у регистратора).
* SSH-ключ: `ssh-keygen -t ed25519`, если ключа ещё нет.

## 2. Виртуальная машина (≈ 5 минут, в консоли console.yandex.cloud)

1. **Compute Cloud → Создать ВМ**.
   * Образ: **Ubuntu 24.04 LTS**.
   * Зона: `ru-central1-a` (или любая).
   * vCPU 2 (гарантированная доля 100 %), RAM **8 ГБ**. 4 ГБ хватит для одного
     небольшого магазина, но впритык. Диск SSD **40 ГБ**.
   * Сеть: публичный адрес **статический** (Зарезервировать).
   * Доступ: логин `admin` (или любой) и ваш **публичный** SSH-ключ.
2. **Группа безопасности** (VPC → Группы безопасности), входящие правила:
   TCP 22 (лучше только с вашего IP), TCP 80, TCP 443, UDP 443. Больше ничего:
   Postgres и панель Studio слушают только localhost.
3. **DNS**: A-запись `shop.example.ru` → статический IP ВМ. Подождите, пока
   `ping shop.example.ru` начнёт отвечать с этим адресом. Без этого Caddy не
   получит сертификат.

## 3. Установка (≈ 10–15 минут, в основном скачивание образов)

**Если системный диск меньше 30 ГБ** (например, квота SSD 10 ГБ), добавьте к ВМ
второй диск (HDD 20 ГБ и больше) и до установки разместите на нём данные:

```bash
lsblk                                   # найдите пустой диск без точки монтирования, например vdb
sudo mkfs.ext4 -L data /dev/vdb         # ВНИМАНИЕ: стирает этот диск
sudo mkdir -p /data
echo 'LABEL=data /data ext4 defaults,nofail 0 2' | sudo tee -a /etc/fstab
sudo mount -a
sudo mkdir -p /data/docker /etc/docker
echo '{ "data-root": "/data/docker" }' | sudo tee /etc/docker/daemon.json
sudo ln -s /data/supabase /opt/supabase # Supabase и база будут на /data
```

Репозиторий в этом случае клонируйте в `/data/myaso` и сделайте ссылку
`sudo ln -s /data/myaso /opt/myaso`.


```bash
ssh admin@shop.example.ru
sudo apt-get update && sudo apt-get install -y git
sudo git clone https://github.com/KSGTEAMS/myaso.git /opt/myaso
cd /opt/myaso
sudo deploy/yandex/app.sh install shop.example.ru --email you@example.ru
```

Скрипт:
1. запускает официальный установщик Supabase (`setup.sh`, релиз
   `self-hosted/v0.8.2`): ставит Docker, генерирует все секреты и ключи в
   `/opt/supabase/.env`;
2. настраивает URL, **отключает публичную регистрацию**, включает Caddy с
   HTTPS, закрывает Postgres и Studio от интернета;
3. генерирует секреты приложения (`/opt/supabase/app/functions.env`): ключи
   VAPID для push, секрет cron, соль для лимитов;
4. ставит Edge Functions, применяет миграции и кладёт в Vault настройки для
   cron уведомлений;
5. публикует магазины из `tenants/registry.json` с демо-данными, создаёт
   владельцев и **печатает их пароли** — сохраните их;
6. собирает сайт и отдаёт его через Caddy.

В конце будут адреса:

```
https://shop.example.ru/s/rebro/        витрина
https://shop.example.ru/s/rebro/owner/  кабинет владельца
```

Проверка одного магазина: `sudo deploy/yandex/app.sh verify rebro`.

## 4. Ежедневная работа

Источник правды — репозиторий на GitHub. Меняете там (или локально и
`git push`) файлы `tenants/<slug>/business.json`, фото в
`tenants/<slug>/images/`, `tenants/registry.json`. Затем на сервере:

```bash
cd /opt/myaso && sudo git pull && sudo deploy/yandex/app.sh update
```

`update` обновляет функции и миграции, публикует все магазины из реестра
(заказы и фото владельцев сохраняются) и пересобирает сайт.

| Задача | Команда (на сервере, из /opt/myaso, через sudo) |
|---|---|
| Новый магазин | добавить `tenants/<slug>/` и строку в `tenants/registry.json` → `git pull` → `app.sh update` |
| Запустить магазин «по-настоящему» | в `registry.json` поставить `"status": "live"` → `app.sh update` (сервер проверит готовность, демо удалится) |
| Ещё один владелец/сотрудник | `app.sh invite --slug rebro --email kassir@example.ru --role staff` |
| Проверка | `app.sh verify rebro` |
| Состояние/логи | `app.sh status`, `app.sh logs functions`, `app.sh logs caddy` |
| Бэкап базы | `app.sh backup` → `/opt/backups/*.dump` (храните 14 дней) |
| Панель базы (Studio) | на своём компьютере `ssh -L 3000:127.0.0.1:3000 admin@shop.example.ru`, затем http://localhost:3000. Логин и пароль — `app.sh keys` |

Автобэкап раз в сутки и автопродление сертификата:

```bash
echo '15 3 * * * root /opt/myaso/deploy/yandex/app.sh backup >/dev/null 2>&1' | sudo tee /etc/cron.d/myaso-backup
```

Сертификаты Caddy продлевает сам. Дополнительно включите **снимки диска по
расписанию** (Compute Cloud → Снимки → Расписания) — это бэкап всей машины.

## 5. Уведомления

Push уже работают: ключи VAPID сгенерированы при установке, cron каждую
минуту разбирает очередь уведомлений. Владелец включает их в кабинете:
«Ещё» → «Уведомления о заказах». На iPhone push приходят только приложению,
установленному на экран «Домой».

## 6. ИИ-помощник на YandexGPT (необязательно)

1. В консоли: **Сервисные аккаунты → Создать** с ролью
   `ai.languageModels.user`. Затем **Создать новый ключ → API-ключ** и
   сохраните секрет.
2. Узнайте ID каталога (folder ID): в консоли сверху, рядом с названием каталога.
3. На сервере отредактируйте `/opt/supabase/app/functions.env`:
   ```
   LLM_BASE_URL=https://llm.api.cloud.yandex.net/v1
   LLM_API_KEY=<секрет API-ключа>
   LLM_MODEL=gpt://<folder-id>/yandexgpt/latest
   LLM_TOOL_MODE=auto
   LLM_JSON_RESPONSE_FORMAT=true
   ```
   и выполните `sudo deploy/yandex/app.sh restart`.
4. Проверьте в кабинете: «Ещё» → «Помощник» → «Сколько оплат получили
   сегодня?». Под ответом не должно быть пометки «без ИИ».
   * Если модель не поддерживает вызов инструментов, поставьте
     `LLM_TOOL_MODE=json`.
   * Если ругается на `response_format`, поставьте
     `LLM_JSON_RESPONSE_FORMAT=false`.

   В любом случае данные о заказах и деньгах берутся из SQL до ответа модели.
   Без ИИ помощник отвечает шаблоном.

Лимит расхода: `LLM_TENANT_DAILY_TOKENS` (на магазин в сутки) и
`LLM_GLOBAL_DAILY_TOKENS` (на всю платформу). Счётчики хранятся в базе.

## 7. Если что-то не так

| Симптом | Что проверить |
|---|---|
| Сайт не открывается по https | A-запись указывает на IP ВМ? Порты 80/443 открыты в группе безопасности? `app.sh logs caddy` |
| «Не удалось загрузить» на витрине | `app.sh status`: все контейнеры `healthy`? `app.sh logs rest` |
| Оформление заказа даёт ошибку | `app.sh logs functions` |
| Нет push | `/opt/supabase/app/functions.env` содержит VAPID; в Studio: `select status, last_error from notification_jobs order by id desc limit 20;` |
| Установка падает на скачивании образов («429 Too Many Requests», таймауты) | Docker Hub ограничивает анонимные загрузки и бывает недоступен из РФ. Скрипт повторяет попытки сам; если не помогло — запустите установку с зеркалом: `app.sh install shop.example.ru --mirror https://<зеркало Docker Hub>` (при проверке работало `--mirror https://mirror.gcr.io`; подойдёт и зеркало вашего хостинга). Повторный запуск `install` безопасен: секреты сохраняются |
| Нужно начать с нуля | `cd /opt/supabase && sudo sh reset.sh` (удалит ВСЕ данные), затем снова `app.sh install …` |

## 8. Стоимость (ориентир)

ВМ 2 vCPU / 8 ГБ / 40 ГБ SSD с публичным IP — порядка 3–4 тыс. ₽ в месяц;
4 ГБ RAM — заметно дешевле. YandexGPT оплачивается по токенам, расход
ограничен лимитами выше. Актуальные цены — в калькуляторе Яндекс Облака.
