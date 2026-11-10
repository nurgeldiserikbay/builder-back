# Запуск BuildPath на сервере

Инструкция для одного сервера с Docker. Всё приложение — платформа, консоль, API, сервер опубликованных сайтов, база, антивирус и резервные копии — запускается одной командой. HTTPS настраивается автоматически (Let's Encrypt через Caddy).

> Что проверено: образы и запуск через Docker в среде разработки **не собирались** (там нет Docker). Проверено отдельно: production-сборка front и admin (`output: standalone`), работа приложения через один адрес с `/api` в режиме `NODE_ENV=production`, все миграции на пустой базе (схема совпадает с рабочей), резервная копия и восстановление (в том числе зашифрованной), проверка разрешения на сертификат и здоровья сервера сайтов, отправка ошибок в Sentry-совместимый сервер. Первый запуск на сервере стоит провести по чек-листу в конце.

## 1. Что нужно заранее

| Что | Зачем | Пример |
|---|---|---|
| Сервер Linux (Ubuntu 24.04), 2 vCPU, 4 ГБ RAM, 40 ГБ SSD | Всё приложение; ClamAV один занимает около 1,5 ГБ памяти | PS.kz, Hoster.kz или зарубежное облако |
| Домен | Адрес платформы | `buildpath.kz` |
| Доступ к DNS домена | Направить адреса на сервер | панель регистратора |
| Почта для Let's Encrypt | Предупреждения о сертификатах | `admin@buildpath.kz` |
| Ключ OpenAI | ИИ на этапах (оплачивается OpenAI) | задаёте сами в `.env.production` |
| Telegram-бот | Уведомления и работа в Telegram | создаётся у @BotFather |
| Ключ Resend и подтверждённый домен почты | Письма (подтверждение почты, приглашения, заявки) | resend.com |

**Персональные данные.** Платформа хранит данные пользователей и заявки посетителей сайтов. По закону РК «О персональных данных и их защите» база с данными граждан Казахстана должна находиться на территории РК. Перед выбором сервера уточните это у юриста; сервер в Казахстане снимает вопрос.

## 2. DNS

Создайте у регистратора записи типа A на IP сервера:

| Имя | Для чего |
|---|---|
| `buildpath.kz` | приложение и API (`APP_HOST`) |
| `admin.buildpath.kz` | консоль сотрудников (`ADMIN_HOST`) |
| `*.sites.buildpath.kz` | опубликованные сайты клиентов (`SITES_BASE_DOMAIN=sites.buildpath.kz`) |

Сертификат для каждого сайта выпускается при первом открытии — только если такой сайт действительно опубликован. Ограничение Let's Encrypt — около 50 новых сертификатов в неделю на домен; для беты этого хватает. При росте переходите на один wildcard-сертификат через DNS-проверку (нужна сборка Caddy с плагином вашего DNS-провайдера).

Совет: сайты клиентов надёжнее держать на отдельном домене (например, `buildpath.site`), как GitHub держит страницы на `github.io`. Тогда в DNS нужна запись `*.buildpath.site`, а в `.env.production` — `SITES_BASE_DOMAIN=buildpath.site`.

## 3. Установка на сервер

```bash
# Docker
curl -fsSL https://get.docker.com | sh

# Код (все три репозитория рядом)
sudo mkdir -p /opt/buildpath && sudo chown "$USER" /opt/buildpath && cd /opt/buildpath
git clone https://github.com/nurgeldiserikbay/builder-back.git
git clone https://github.com/nurgeldiserikbay/builder-front.git
git clone https://github.com/nurgeldiserikbay/builder-admin.git

# Настройки
cd /opt/buildpath/builder-back/deploy
cp .env.production.example .env.production
chmod 600 .env.production
nano .env.production
```

Что заполнить в `.env.production`:

- адреса: `APP_HOST`, `ADMIN_HOST`, `SITES_BASE_DOMAIN`, `SITES_PUBLIC_URL_TEMPLATE`, `PUBLIC_APP_URL`, `ACME_EMAIL`;
- `POSTGRES_PASSWORD` — `openssl rand -hex 32`; тот же пароль вставьте в `DATABASE_URL` вместо `CHANGE_ME`;
- `SITES_IP_HASH_SALT`, `TELEGRAM_WEBHOOK_SECRET`, `BACKUP_ENCRYPTION_PASSPHRASE` — каждый `openssl rand -hex 32`;
- `RESEND_API_KEY`, `EMAIL_FROM`, `BUILDER_AI_OPENAI_API_KEY`, `BUILDER_AI_OPENAI_MODEL`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`.

Пароль шифрования резервных копий храните отдельно от сервера (например, в менеджере паролей): без него зашифрованную копию не восстановить.

## 4. Первый запуск

```bash
cd /opt/buildpath/builder-back/deploy
alias bp='docker compose -f compose.prod.yaml --env-file .env.production'

bp build                                  # сборка образов (5–15 минут; во время сборки проходят автотесты)
bp up -d postgres clamav                  # база и антивирус
bp run --rm api npm run db:migrate:deploy # создание таблиц
bp up -d                                  # всё остальное
bp ps                                     # все сервисы должны быть running / healthy
```

ClamAV при первом запуске скачивает базы сигнатур несколько минут; до этого загрузка фото отвечает «Проверка файлов сейчас недоступна». Это ожидаемо.

Учётная запись сотрудника для консоли:

```bash
bp run --rm -it api npx tsx scripts/create-staff-account.ts
```

Скрипт спросит почту, имя и пароль. Затем откройте `https://admin.buildpath.kz`, войдите и в разделе «Plan prices» проверьте цены и впишите ссылку для связи по тарифам.

## 5. Telegram

1. Подключите webhook (подставьте токен, адрес и секрет из `.env.production`):

```bash
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=https://buildpath.kz/api/v1/telegram/webhook&secret_token=<TELEGRAM_WEBHOOK_SECRET>"
```

2. По желанию у @BotFather: `/setmenubutton` → `https://buildpath.kz/projects?tg=1` — кнопка «Открыть приложение» в чате с ботом. Кнопки «Открыть в приложении» в сообщениях бота работают и без этого, если адрес приложения на HTTPS.
3. Проверьте: в профиле на платформе привяжите Telegram, бот должен ответить списком проектов.

## 6. Проверка после запуска (чек-лист)

- [ ] `https://buildpath.kz` открывается с замком; `https://buildpath.kz/api/v1/health` отвечает `ok`.
- [ ] Регистрация: письмо с подтверждением приходит.
- [ ] Создать проект, пройти «Цель сайта» с ИИ — черновик появляется, тексты разумные.
- [ ] Загрузить фото с телефона — загружается (после обновления баз ClamAV).
- [ ] Собрать и опубликовать сайт — `https://<адрес>.sites.buildpath.kz` открывается с замком (первое открытие может занять 5–10 секунд — выпускается сертификат).
- [ ] Отправить заявку с сайта — уведомление пришло в Telegram и на почту.
- [ ] Консоль `https://admin.buildpath.kz` — вход сотрудника, цены видны.
- [ ] `bp exec backup /scripts/backup.sh` — копия появилась в `deploy/backups` (и в облаке, если настроено).
- [ ] Ошибки: если задан `SENTRY_DSN`, в Sentry/GlitchTip видно событие после тестовой ошибки.

## 7. Обновление

```bash
cd /opt/buildpath
for repo in builder-back builder-front builder-admin; do git -C "$repo" pull --ff-only; done
cd builder-back/deploy
bp exec backup /scripts/backup.sh          # копия перед обновлением
APP_RELEASE=$(git rev-parse --short HEAD) bp build
bp run --rm api npm run db:migrate:deploy
APP_RELEASE=$(git rev-parse --short HEAD) bp up -d
```

## 8. Резервные копии и восстановление

- Каждый день в 02:30 (время из `TZ`) сервис `backup` делает копию базы в `deploy/backups`, проверяет, что её можно прочитать, и удаляет копии старше `BACKUP_KEEP_DAYS` дней. В базе всё: аккаунты, проекты, версии этапов, фото, заявки, настройки.
- Копии на том же сервере не спасут при потере сервера. Настройте копирование в облачное хранилище, совместимое с S3 (лучше в Казахстане): заполните `BACKUP_REMOTE` и `RCLONE_CONFIG_OFFSITE_*`. В облако копии уходят зашифрованными паролем `BACKUP_ENCRYPTION_PASSPHRASE`.
- Сделать копию сейчас: `bp exec backup /scripts/backup.sh`.

Восстановление (заменяет все текущие данные):

```bash
bp stop api sites front admin
bp run --rm --entrypoint /scripts/restore.sh backup /backups/buildpath-ГГГГММДДTЧЧММССZ.dump
bp up -d
```

Для зашифрованной копии из облака сначала скачайте её (`bp exec backup rclone copy offsite:<bucket>/postgres/<файл>.dump.gpg /backups/`), затем укажите путь к файлу `.gpg`. Раз в месяц проверяйте восстановление на отдельной базе — непроверенная копия может подвести.

Файлы инструмента сравнения с макетом (MinIO, профиль `design-review`) в эти копии не входят.

## 9. Ошибки и наблюдение

- **Ошибки приложения.** Задайте `SENTRY_DSN` (API, сервер сайтов, worker) и `NEXT_PUBLIC_SENTRY_DSN` (браузер; нужна пересборка `front` и `admin`). Подходит sentry.io или свой GlitchTip (совместим с Sentry, можно поставить на сервер в РК). В отчёты не попадают cookies, тела запросов, параметры адресов, токены приглашений и данные пользователей. Ожидаемые ошибки (неверный ввод, лимит тарифа) не отправляются.
- **Доступность.** Подключите внешний мониторинг (UptimeRobot, Better Stack и т. п.) на `https://buildpath.kz/api/v1/health` и на любой опубликованный сайт.
- **Логи.** `bp logs -f api`, `bp logs -f sites`, `bp logs backup`. Логи ограничены 5 файлами по 20 МБ на сервис.
- **Место на диске.** `df -h` и `du -sh deploy/backups`; база растёт в основном за счёт фото (до 2 МБ на фото, до 30 фото на проект).

## 10. Безопасность

- Откройте наружу только порты 80 и 443 (и 22 для SSH): `ufw allow 22,80,443/tcp && ufw allow 443/udp && ufw enable`. База, ClamAV и внутренние сервисы наружу не публикуются.
- `.env.production` — права 600, не копируйте его в чаты и репозитории.
- Обновляйте систему (`unattended-upgrades`) и образы (`bp pull && bp up -d` для caddy, postgres, clamav).
- Консоль сотрудников закрыта паролем и ролями. Дополнительно можно ограничить `ADMIN_HOST` по IP в `Caddyfile` (директива `@blocked not remote_ip ...`).
