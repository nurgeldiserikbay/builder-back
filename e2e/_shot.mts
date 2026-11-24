import { chromium } from 'playwright-core';
const [,, email, outDir, ...paths] = process.argv;
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome' });
for (const vp of [{ n: 'd', width: 1440, height: 900 }, { n: 'm', width: 390, height: 844 }]) {
  const ctx = await b.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 1, locale: 'ru-RU' });
  const p = await ctx.newPage();
  await p.goto('http://localhost:3000/login', { waitUntil: 'networkidle' });
  await p.getByLabel(/Почта|Email/i).first().fill(email); await p.getByLabel(/Пароль/i).first().fill('E2e-owner-pass-2026');
  await p.getByRole('button', { name: /^Войти/ }).last().click(); await p.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 });
  for (const path of paths) {
    await p.goto('http://localhost:3000' + path, { waitUntil: 'networkidle' }).catch(()=>{}); await p.waitForTimeout(1200);
    const name = (path.replace(/[^a-z0-9]+/gi, '_') || 'root') + '_' + vp.n;
    await p.screenshot({ path: `${outDir}/${name}.png`, fullPage: false });
  }
  await ctx.close();
}
await b.close();
