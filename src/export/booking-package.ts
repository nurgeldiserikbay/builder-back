// Files for running a site with online booking on the owner's own server: the bundled app, its config and plain instructions.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { SiteArtifact } from '../journey/artifacts.js';
import type { ExportConfig } from './booking-server.js';

export const BOOKING_EXPORT_VERSION = '1.0.0';
export const BOOKING_BUNDLE_PATH = path.resolve(process.env.BOOKING_EXPORT_BUNDLE ?? 'dist/export/booking-server.mjs');

export class ExportNotBuiltError extends Error {}

export async function bookingBundle(): Promise<string> {
  try { return await readFile(BOOKING_BUNDLE_PATH, 'utf8'); } catch { throw new ExportNotBuiltError('EXPORT_NOT_BUILT'); }
}

export function bookingPackageFiles(site: SiteArtifact, bundle: string) {
  if (!site.meta?.booking) throw new Error('NOT_A_BOOKING_SITE');
  const config: ExportConfig = { version: BOOKING_EXPORT_VERSION, meta: site.meta, booking: site.meta.booking };
  const caddy = ['# Замените ВАШ-ДОМЕН.kz на свой домен. Caddy сам получит HTTPS-сертификат.', 'ВАШ-ДОМЕН.kz {', '\tencode gzip', '\treverse_proxy app:8080', '}', ''].join('\n');
  const compose = [
    'services:',
    '  app:',
    '    image: node:22-alpine',
    '    restart: unless-stopped',
    '    command: ["node", "/app/server.mjs"]',
    '    environment:',
    '      DATA_DIR: /data',
    '    env_file: .env',
    '    volumes:',
    '      - ./app:/app:ro',
    '      - ./data:/data',
    '  caddy:',
    '    image: caddy:2',
    '    restart: unless-stopped',
    '    ports: ["80:80", "443:443"]',
    '    volumes:',
    '      - ./Caddyfile:/etc/caddy/Caddyfile:ro',
    '      - caddy_data:/data',
    '    depends_on: [app]',
    'volumes:',
    '  caddy_data: {}',
    '',
  ].join('\n');
  const env = [
    '# Пароль для страницы /admin со списком записей. Придумайте длинный пароль (не меньше 12 символов).',
    'ADMIN_PASSWORD=',
    '# Необязательно: уведомления о записях в Telegram (см. README.md).',
    'TELEGRAM_BOT_TOKEN=',
    'TELEGRAM_CHAT_ID=',
    '',
  ].join('\n');
  const readme = [
    `# Сайт «${site.meta.businessName}» с онлайн-записью на своём сервере`, '',
    'Внутри: страница сайта, программа записи (один файл, без сторонних библиотек, Node.js 22+) с вашим расписанием, веб-сервер Caddy с автоматическим HTTPS.', '',
    'Нужно: сервер с Ubuntu 24.04 (1 ядро, 1 ГБ памяти достаточно) и домен, направленный на IP сервера (запись A).', '',
    '## Запуск', '',
    '1. В файле `Caddyfile` замените `ВАШ-ДОМЕН.kz` на свой домен.',
    '2. Переименуйте `.env.example` в `.env` и впишите `ADMIN_PASSWORD` — пароль для страницы записей.',
    '3. Скопируйте папку на сервер (команда на своём компьютере): `scp -r buildpath-site root@IP-СЕРВЕРА:/opt/`',
    '4. Подключитесь к серверу (`ssh root@IP-СЕРВЕРА`) и выполните:', '',
    '```', 'curl -fsSL https://get.docker.com | sh', 'cd /opt/buildpath-site', 'mkdir -p data', 'docker compose up -d', '```', '',
    '5. Откройте свой домен: на сайте работает запись (`/book`). Записи — на странице `https://ВАШ-ДОМЕН.kz/admin` (любое имя пользователя и пароль из `.env`).',
    '6. Вернитесь в BuildPath и нажмите «Проверить адрес».', '',
    '## Уведомления в Telegram (по желанию)', '',
    '1. В Telegram откройте @BotFather, отправьте `/newbot` и получите токен бота — впишите его в `TELEGRAM_BOT_TOKEN`.',
    '2. Напишите своему боту любое сообщение, затем откройте в браузере `https://api.telegram.org/bot<ТОКЕН>/getUpdates` и найдите `"chat":{"id":...}` — это число впишите в `TELEGRAM_CHAT_ID`.',
    '3. Перезапустите: `docker compose up -d`.', '',
    '## Где хранятся записи и как их сохранить', '',
    'Записи лежат в файле `data/bookings.json` на сервере. Делайте копию этого файла (например, раз в день) — без неё при поломке сервера записи пропадут. Записи старше 12 месяцев после визита удаляются автоматически.', '',
    '## Обновление', '',
    'Когда вы измените сайт или расписание в BuildPath, скачайте пакет заново и замените на сервере только папку `app`, затем выполните `docker compose restart app`. Папку `data` не трогайте — в ней записи.', '',
    '## Ограничения', '',
    '- Запускайте одну копию программы: она не рассчитана на несколько серверов сразу.',
    '- Клиент не получает SMS или сообщений: подтверждение и отмена — по личной ссылке на странице записи.',
    '- Обновления сервера, резервные копии и продление домена — ваша задача или вашего специалиста.', '',
    `Версия пакета: ${BOOKING_EXPORT_VERSION}. Сборка сайта: ${site.compiledAt}.`, '',
  ].join('\n');
  return [
    { name: 'app/server.mjs', mimeType: 'text/javascript', content: bundle },
    { name: 'app/config.json', mimeType: 'application/json', content: `${JSON.stringify(config, null, 2)}\n` },
    { name: 'app/index.html', mimeType: 'text/html', content: site.html },
    { name: 'Caddyfile', mimeType: 'text/plain', content: caddy },
    { name: 'compose.yaml', mimeType: 'text/yaml', content: compose },
    { name: '.env.example', mimeType: 'text/plain', content: env },
    { name: 'README.md', mimeType: 'text/markdown', content: readme },
  ];
}
