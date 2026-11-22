// The whole owner path in a real browser, with the mock AI and the local sandbox (see e2e/README.md): sign-up, a new web
// application project, every stage with the AI and «Разговор», the package, the agent's build, the preview, a change, the
// repository and the launch check. Each step logs one line; a failed step saves a screenshot and the page text to e2e/out.
import { chromium, type Page } from 'playwright-core';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { execSync, spawn } from 'node:child_process';

const SITE = process.env.E2E_SITE_URL ?? 'http://localhost:3000';
const MAIL = process.env.E2E_MAIL_URL ?? 'http://127.0.0.1:4555';
const AI = process.env.E2E_AI_URL ?? 'http://127.0.0.1:4561';
const CHROME = process.env.E2E_CHROME ?? '/usr/bin/google-chrome';
const OUT = new URL('./out/', import.meta.url);
const email = `owner-${Date.now()}@e2e.test`;
const password = 'E2e-owner-pass-2026';

const APP_PORT = Number(process.env.E2E_APP_PORT ?? 4777);
const cleanup: Array<() => void> = [];
const results: Array<{ step: string; ok: boolean; note: string; ms: number }> = [];
let page: Page;
let projectUrl = '';

let stopped = false;
async function step(name: string, run: () => Promise<string | void>): Promise<boolean> {
  // Each step builds on the one before: after a failure the rest is skipped, not reported as a chain of failures.
  if (stopped) { results.push({ step: name, ok: false, note: 'не запускался', ms: 0 }); console.log(`· ${name} — не запускался`); return false; }
  const at = Date.now();
  try {
    const note = (await run()) ?? '';
    results.push({ step: name, ok: true, note, ms: Date.now() - at });
    console.log(`✓ ${name}${note ? ` — ${note}` : ''} (${Math.round((Date.now() - at) / 100) / 10} s)`);
    return true;
  } catch (error) {
    const note = error instanceof Error ? error.message.split('\n')[0]! : String(error);
    results.push({ step: name, ok: false, note, ms: Date.now() - at });
    console.log(`✗ ${name} — ${note}`);
    stopped = true;
    const slug = `step-${results.length}`;
    await page.screenshot({ path: new URL(`${slug}.png`, OUT).pathname, fullPage: true }).catch(() => undefined);
    await writeFile(new URL(`${slug}.txt`, OUT), await page.locator('body').innerText().catch(() => '')).catch(() => undefined);
    return false;
  }
}

const main = () => page.locator('main');
async function waitText(text: string | RegExp, timeout = 30_000) { await page.getByText(text).first().waitFor({ timeout }); }
async function stage(key: string) { await page.goto(`${projectUrl}/stages/${key}`, { waitUntil: 'networkidle' }); }
/** Waits until the agent's task has ended (the panel stops saying it works). */
async function agentDone(card: ReturnType<Page['locator']>) {
  await card.getByText('ИИ-агент работает').first().waitFor({ timeout: 30_000 });
  await card.getByText('ИИ-агент работает').first().waitFor({ state: 'detached', timeout: 600_000 });
}
/** The checks the panel shows as not passed: lines of the check list without the passed mark. */
async function failedChecksIn(card: ReturnType<Page['locator']>): Promise<string[]> {
  const items = await card.locator('li').allInnerTexts();
  return items.filter((item) => /не прошл|не запускал|ошибк/i.test(item)).map((item) => item.split('\n')[0]!.slice(0, 80));
}
/** Saves the draft if asked and accepts the stage (the button reads «Принять этап», «Утвердить» or «Подтвердить»). */
async function accept() {
  const save = page.getByRole('button', { name: 'Сохранить', exact: true });
  if (await save.count() && await save.first().isEnabled()) { await save.first().click(); await page.waitForTimeout(800); }
  await page.getByRole('button', { name: /^(Принять этап|Утвердить|Подтвердить)$/ }).last().click();
  await page.getByText(/Этап принят|принят \(версия/).first().waitFor({ timeout: 20_000 });
}

await mkdir(OUT, { recursive: true });
// A fake microphone, so the voice answer can be recorded headless.
const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, locale: 'ru-RU', permissions: ['microphone'] });
page = await context.newPage();
page.on('dialog', (dialog) => void dialog.accept());
const pageErrors: string[] = [];
page.on('pageerror', (error) => pageErrors.push(error.message));

await step('Регистрация и подтверждение почты', async () => {
  await page.goto(`${SITE}/login`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Зарегистрироваться' }).click();
  await page.getByLabel(/Почта|Email/i).first().fill(email);
  await page.getByLabel(/Пароль/i).first().fill(password);
  await page.locator('label').filter({ hasText: /оферт/i }).locator('input[type=checkbox]').check();
  await page.getByRole('button', { name: /Создать аккаунт|Зарегистрироваться/ }).last().click();
  await waitText(/Письмо отправлено|подтвердите/i);
  let letter: { html: string; text: string } | null = null;
  for (let i = 0; i < 20 && !letter; i += 1) {
    const response = await fetch(`${MAIL}/last?to=${encodeURIComponent(email)}`);
    letter = response.ok ? await response.json() as { html: string; text: string } : null;
    if (!letter) await page.waitForTimeout(500);
  }
  if (!letter) throw new Error('письмо с подтверждением не пришло');
  const link = /https?:\/\/[^\s"'<>]+verify-email[^\s"'<>]*/.exec(`${letter.text} ${letter.html}`)?.[0]?.replace(/&amp;/g, '&');
  if (!link) throw new Error('в письме нет ссылки подтверждения');
  await page.goto(link.replace(/^https?:\/\/[^/]+/, SITE), { waitUntil: 'networkidle' });
  await page.goto(`${SITE}/login`, { waitUntil: 'networkidle' });
  await page.getByLabel(/Почта|Email/i).first().fill(email);
  await page.getByLabel(/Пароль/i).first().fill(password);
  await page.getByRole('button', { name: /^Войти/ }).last().click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 20_000 });
  return email;
});

await step('Новый проект «Веб-приложение» через мастер', async () => {
  await page.goto(`${SITE}/projects`, { waitUntil: 'networkidle' });
  await page.getByLabel('О вашем деле').fill('Ремонтируем бытовую технику на дому в Астане. Клиенты оставляют заявки, диспетчер назначает мастера, мастер чинит и закрывает заявку. Нужен учёт заявок с ролями.');
  await page.getByRole('button', { name: 'Дальше' }).click();
  await waitText('Уточним пару вещей');
  const recommended = await page.locator('section[aria-live="polite"]').innerText();
  if (!recommended.includes('Веб-приложение')) throw new Error(`рекомендован не «Веб-приложение»: ${recommended.slice(0, 120)}`);
  if (/Этапы: Цель сайта/.test(recommended)) throw new Error('в списке этапов приложения стоит «Цель сайта»');
  await page.getByRole('button', { name: 'Дальше' }).click();
  await page.getByLabel('Название проекта').fill('Мастер Дома — e2e');
  await page.getByRole('button', { name: 'Дальше' }).click();
  await page.getByRole('button', { name: 'Создать проект' }).click();
  await page.waitForURL(/\/projects\/[0-9a-f-]+$/, { timeout: 20_000 });
  projectUrl = page.url();
});

await step('Цель: «Разговор» и форма для приложения', async () => {
  await stage('goal');
  const text = await main().innerText();
  const siteWords = ['сайт получится', 'посетитель должен сделать на сайте', 'Цель сайта — договорённость', 'заголовке сайта'].filter((words) => text.includes(words));
  await page.getByRole('button', { name: '💬 Начать разговор' }).click();
  await page.locator('#interview-text').waitFor();
  for (const answer of ['Я, диспетчер и два мастера', 'Клиент оставляет заявку, диспетчер назначает мастера']) {
    await page.fill('#interview-text', answer);
    await page.getByRole('button', { name: 'Отправить', exact: true }).click();
    await page.waitForTimeout(1200);
  }
  await page.getByRole('button', { name: 'Заполнить форму' }).click();
  await page.waitForTimeout(1500);
  const pressed = await page.locator('button[aria-pressed="true"]').filter({ hasText: 'Оставить заявку в приложении' }).count();
  if (!pressed) throw new Error('после разговора главное действие не «Оставить заявку в приложении»');
  await accept();
  if (siteWords.length) throw new Error(`тексты про сайт у приложения: ${siteWords.join('; ')}`);
});

await step('Процесс: «Разговор», черновик ИИ, ситуации, принятие', async () => {
  await stage('process');
  await page.getByRole('button', { name: '💬 Начать разговор' }).click();
  await page.locator('#interview-text').waitFor();
  // The first answer by voice: consent, record two seconds, the recognised text lands in the answer field.
  await page.fill('#interview-text', '');
  await page.getByRole('button', { name: '🎙 Ответить голосом' }).click();
  await page.getByRole('button', { name: 'Разрешить и записать' }).click();
  await page.getByRole('button', { name: /Запись .* нажмите, чтобы закончить/ }).waitFor({ timeout: 10_000 });
  await page.waitForTimeout(2000);
  await page.getByRole('button', { name: /Запись .* нажмите, чтобы закончить/ }).click();
  await page.waitForFunction(() => (document.querySelector('#interview-text') as HTMLTextAreaElement | null)?.value.includes('диспетчер'), null, { timeout: 20_000 });
  await page.getByRole('button', { name: 'Отправить', exact: true }).click();
  await page.waitForTimeout(1200);
  for (const answer of ['Клиент оставляет заявку, диспетчер назначает мастера, мастер чинит и закрывает']) {
    await page.fill('#interview-text', answer);
    await page.getByRole('button', { name: 'Отправить', exact: true }).click();
    await page.waitForTimeout(1200);
  }
  await page.getByRole('button', { name: /Составить по разговору/ }).click();
  await waitText('ИИ составил этап по разговору');
  const text = await main().innerText();
  if (!text.includes('Назначить исполнителя')) throw new Error('у шагов процесса нет действий приложения');
  await page.getByRole('button', { name: 'Ответить на остальные как обычно' }).click();
  await page.waitForTimeout(800);
  await accept();
  const siteWords = ['ИИ напишет тексты сайта', 'покажет, что сделает сайт, а что', 'что будет делать сайт'].filter((words) => text.includes(words));
  if (siteWords.length) throw new Error(`тексты про сайт у приложения: ${siteWords.join('; ')}`);
});

await step('ТЗ: черновик ИИ и принятие', async () => {
  await stage('features');
  // The provider is overloaded twice (the platform retries once): the owner sees a plain message and can try again.
  await fetch(`${AI}/__fail?count=2&status=503`, { method: 'POST' });
  await page.getByRole('button', { name: /Пусть ИИ предложит роли и функции/ }).click();
  const busy = page.getByRole('alert').filter({ hasText: /ИИ|перегруж|занят|позже/i });
  await busy.first().waitFor({ timeout: 30_000 });
  const message = (await busy.first().innerText()).slice(0, 140);
  await page.getByRole('button', { name: /Пусть ИИ предложит роли и функции/ }).click();
  await page.waitForTimeout(3000);
  await accept();
  return `при перегрузке: «${message}»`;
});

await step('Экраны: черновик ИИ, прототип, принятие', async () => {
  await stage('screens');
  await page.getByRole('button', { name: /Пусть ИИ предложит экраны/ }).click();
  await page.waitForTimeout(3000);
  const prototype = page.getByRole('button', { name: /прототип/i }).or(page.getByRole('link', { name: /прототип/i }));
  const hasPrototype = await prototype.count();
  await accept();
  return hasPrototype ? '' : 'кнопки прототипа не нашлось';
});

await step('Архитектура и пакет для разработки', async () => {
  await stage('techplan');
  const techplan = await main().innerText();
  await accept();
  await stage('handoff');
  await page.getByRole('button', { name: 'Собрать пакет' }).click();
  await waitText('⬇ Скачать пакет (.zip)');
  const handoff = await main().innerText();
  const siteWords = [
    ...(/делает сайт/.test(techplan) ? ['архитектура: «делает сайт»'] : []),
    ...(handoff.includes('Код приложения BuildPath не пишет') ? ['пакет: «Код приложения BuildPath не пишет»'] : []),
  ];
  if (siteWords.length) throw new Error(`устаревшие тексты: ${siteWords.join('; ')}`);
});

await step('ИИ-агент пишет приложение, все проверки', async () => {
  const card = page.locator('section[aria-labelledby="agent-title"]');
  await card.scrollIntoViewIfNeeded();
  await card.getByRole('button', { name: 'Собрать приложение' }).click();
  await agentDone(card);
  const text = await card.innerText();
  await writeFile(new URL('agent-build.txt', OUT), text);
  const failedChecks = await failedChecksIn(card);
  if (failedChecks.length) throw new Error(`не прошли проверки: ${failedChecks.join(', ')}`);
  return 'все проверки прошли';
});

await step('Превью приложения в браузере', async () => {
  const card = page.locator('section[aria-labelledby="agent-title"]');
  await card.getByRole('button', { name: '▶ Попробовать приложение' }).click();
  const frame = page.frameLocator('iframe').first();
  await frame.getByText('Стиральная машина не сливает воду').waitFor({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Закрыть' }).click();
});

await step('Правка от владельца через агента', async () => {
  const card = page.locator('section[aria-labelledby="agent-title"]');
  await card.getByLabel('Что изменить в приложении?').fill('Поменяй заголовок на «Мастер Дома — заявки».');
  await card.getByRole('button', { name: 'Поручить изменение агенту' }).click();
  await agentDone(card);
  const failedChecks = await failedChecksIn(card);
  if (failedChecks.length) throw new Error(`не прошли проверки: ${failedChecks.join(', ')}`);
  await card.getByRole('button', { name: '▶ Попробовать приложение' }).click();
  await page.frameLocator('iframe').first().getByText('Мастер Дома — заявки').first().waitFor({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Закрыть' }).click();
  return 'правка видна в превью';
});

// The owner's git server: a local bare repository behind sshd (see README). The run adds the platform's deploy key to the
// server's authorized_keys itself, as the owner would.
const SSH_REPO = process.env.E2E_SSH_REPO ?? '';
const AUTHORIZED_KEYS = process.env.E2E_AUTHORIZED_KEYS ?? '/root/.ssh/authorized_keys';
if (SSH_REPO) {
  await step('Репозиторий: свой git-сервер по SSH', async () => {
    await page.goto(`${projectUrl}/choices/code_hosting`, { waitUntil: 'networkidle' });
    const choice = await main().innerText();
    if (/Рекомендуем\s+Скачать архив/.test(choice) || choice.includes('Сайт уже работает на BuildPath')) throw new Error('для приложения рекомендован архив как для сайта');
    const option = page.locator('article, section, li, div').filter({ has: page.getByText('Любой git-сервер по SSH', { exact: true }) }).filter({ has: page.getByRole('button', { name: 'Выбрать' }) }).last();
    await option.getByRole('button', { name: 'Выбрать' }).click();
    await page.waitForTimeout(1500);
    await writeFile(new URL('code-hosting.txt', OUT), await main().innerText());
    await page.getByRole('button', { name: 'Создать ключ' }).click();
    const key = page.locator('#ssh-public-key');
    await key.waitFor();
    await appendFile(AUTHORIZED_KEYS, `${await key.inputValue()}\n`);
    await page.fill('#ssh-url', SSH_REPO);
    await page.getByRole('button', { name: 'Проверить сервер' }).click();
    await page.locator('input[name=host-key]').first().check({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Отпечаток совпадает, подключить' }).click();
    await page.waitForTimeout(3000);
    await writeFile(new URL('code-hosting-after.txt', OUT), await main().innerText());
  });

  await step('Код уходит в репозиторий', async () => {
    await stage('handoff');
    const card = page.locator('section[aria-labelledby="agent-title"]');
    await card.getByRole('button', { name: 'Отправить в репозиторий' }).click();
    await card.getByText(/Отправлено в ветку/).waitFor({ timeout: 60_000 });
    const branches = execSync(`git --git-dir=${process.env.E2E_SSH_REPO_DIR ?? '/tmp/e2e/flow.git'} branch --list`, { encoding: 'utf8' }).trim();
    if (!branches) throw new Error('в репозитории нет веток после отправки');
    return `ветки: ${branches.replace(/\s+/g, ' ')}`;
  });

  await step('Правка «из репозитория», пока ветку агента не слили', async () => {
    // The main branch is still empty: the change must either start from the latest task or say plainly what to do.
    const card = page.locator('section[aria-labelledby="agent-title"]');
    const before = await card.locator('li').count();
    await card.getByLabel('Что изменить в приложении?').fill('Добавь в заявку поле «Телефон».');
    await card.getByRole('button', { name: 'Поручить изменение агенту' }).click();
    await page.waitForTimeout(3000);
    const alert = (await card.getByRole('alert').allInnerTexts()).join(' ').trim();
    const working = await card.getByText('ИИ-агент работает').count();
    if (working) { await agentDone(card); return 'правка запущена'; }
    if (!alert) throw new Error('ни задачи, ни понятного сообщения');
    void before;
    return `сообщение: ${alert.slice(0, 160)}`;
  });

  await step('Запуск у вас: приложение из ветки отвечает', async () => {
    // As the owner would: the code is taken from the pushed branch, built and started; the platform checks its address.
    const repoDir = process.env.E2E_SSH_REPO_DIR ?? '/tmp/e2e/flow.git';
    const branch = execSync(`git --git-dir=${repoDir} for-each-ref --format='%(refname:short)' refs/heads`, { encoding: 'utf8' }).trim().split('\n')[0]!;
    const dir = `/tmp/e2e/deploy-${Date.now()}`;
    execSync(`git clone -q -b ${branch} ${repoDir} ${dir} && cd ${dir} && npm run build --silent`, { stdio: 'ignore' });
    const app = spawn('node', ['server.js'], { cwd: dir, env: { ...process.env, PORT: String(APP_PORT) }, stdio: 'ignore', detached: true });
    cleanup.push(() => { try { process.kill(-app.pid!); } catch { /* gone */ } });
    await page.waitForTimeout(1500);
    const card = page.locator('section[aria-labelledby="agent-title"]');
    await page.getByText('Запуск у вас', { exact: true }).scrollIntoViewIfNeeded();
    await page.getByRole('tab', { name: 'Свой сервер' }).click();
    await page.locator('#app-url').fill(`http://127.0.0.1:${APP_PORT}`);
    await page.getByRole('button', { name: 'Проверить', exact: true }).click();
    await page.locator('p[role="status"]').filter({ hasText: 'Приложение работает' }).waitFor({ timeout: 70_000 });
    void card;
    return `ветка ${branch}`;
  });
}

await browser.close();
for (const done of cleanup) done();
const failed = results.filter((item) => !item.ok);
console.log(`\n${results.length - failed.length} of ${results.length} steps passed${pageErrors.length ? `; page errors: ${[...new Set(pageErrors)].slice(0, 5).join(' | ')}` : ''}`);
await writeFile(new URL('results.json', OUT), JSON.stringify({ email, results, pageErrors }, null, 2));
process.exit(failed.length ? 1 : 0);
