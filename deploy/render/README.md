# BuildPath на Render (бесплатная тестовая среда)

Тестовая среда на бесплатных планах Render и Neon. Для production по-прежнему рассчитан один сервер с Docker ([../README.md](../README.md)).

## Что запущено

| Сервис Render | Откуда | Зачем |
|---|---|---|
| `buildpath-api` | этот репозиторий, `Dockerfile` (target `app`) | API; при старте применяет миграции |
| `buildpath-front` | `builder-front`, `Dockerfile` | приложение |
| `buildpath-admin` | `builder-admin`, `Dockerfile` | консоль сотрудников |
| `buildpath-app` | этот репозиторий, `deploy/render/Dockerfile` | вход для пользователей: `/api/*` → API, остальное → приложение |
| `buildpath-console` | то же | вход для сотрудников: `/api/*` → API, остальное → консоль |

База — бесплатный проект Neon (Франкфурт). Все сервисы — регион Frankfurt, план Free.

Пользователи открывают только `buildpath-app` и `buildpath-console`: приложение и API работают на одном адресе, поэтому cookie остаются первичными и CORS не нужен. Бесплатные сервисы Render не принимают трафик по внутренней сети, поэтому вход ходит к остальным по публичным адресам `https://*.onrender.com`.

## Настройки входа (`deploy/render/Dockerfile`)

| Переменная | Пример |
|---|---|
| `API_UPSTREAM` | `https://buildpath-api.onrender.com` |
| `WEB_UPSTREAM` | `https://buildpath-front.onrender.com` или `https://buildpath-admin.onrender.com` |
| `FRAME_POLICY` | приложение: `frame-ancestors 'self' https://web.telegram.org https://*.telegram.org`; консоль: по умолчанию `frame-ancestors 'none'` |
| `NOINDEX` | `true` для консоли |

## Настройки API

Как в `../.env.production.example`, со следующими отличиями:

- `DATABASE_URL` — строка подключения Neon (`?sslmode=require`).
- `PUBLIC_APP_URL` — адрес `buildpath-app`.
- Команда запуска: `sh -c "npx prisma migrate deploy && node dist/main.js"` (на бесплатном плане нет pre-deploy команды).
- `CLAMAV_HOST` не задан — загрузка фото отклоняется («Проверка файлов сейчас недоступна»). Антивирусу нужно 2 ГБ памяти, на бесплатном плане его нет.

## Ограничения бесплатной среды

- Сервис засыпает после 15 минут без запросов; первое открытие после этого занимает до минуты (просыпаются вход, приложение и API).
- На рабочее пространство даётся 750 часов работы бесплатных сервисов в месяц; спящий сервис их не тратит.
- Опубликованные сайты (`*.sites.<домен>`) не работают: для них нужен свой домен с wildcard-записью и сервер сайтов.
- Тестовая оплата (`PAYMENTS_PROVIDER=mock`) в `NODE_ENV=production` выключена.
- Адрес клиента для лимитов определяется приблизительно: запрос проходит через два прокси Render.
- Данные хранятся во Франкфурте; для пользователей из Казахстана это расходится с требованием хранить данные в РК — только для тестов.
