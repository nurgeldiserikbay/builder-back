// Bundles the online booking app for own servers into one dependency-free file (Node.js 22+).
import { build } from 'esbuild';

export const EXPORT_BUNDLE = 'dist/export/booking-server.mjs';

await build({
  entryPoints: ['src/export/booking-entry.ts'],
  outfile: EXPORT_BUNDLE,
  bundle: true, platform: 'node', format: 'esm', target: 'node22', legalComments: 'none', charset: 'utf8',
  banner: { js: '// Сайт с онлайн-записью, собранный BuildPath. Запуск: node server.mjs (Node.js 22+). Подробности — в README.md.' },
});
console.log(`Built ${EXPORT_BUNDLE}`);
