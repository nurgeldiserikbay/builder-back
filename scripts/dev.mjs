// Local development: compiles with tsc (which emits the decorator metadata Nest needs for constructor injection —
// esbuild/tsx does not) and restarts the chosen entry when the output changes.
// Usage: node scripts/dev.mjs main|worker|sites
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const entry = process.argv[2] ?? 'main';
if (!['main', 'worker', 'sites'].includes(entry)) { console.error('Usage: node scripts/dev.mjs main|worker|sites'); process.exit(2); }
const children = [];
const run = (command, args) => { const child = spawn(command, args, { stdio: 'inherit', shell: process.platform === 'win32' }); children.push(child); return child; };
const stop = () => { for (const child of children) child.kill('SIGTERM'); process.exit(0); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);

if (!existsSync('dist/export/booking-server.mjs')) await new Promise((resolve) => run('node', ['scripts/build-export.mjs']).on('exit', resolve));
let started = false;
const tsc = spawn('npx', ['tsc', '-p', 'tsconfig.build.json', '--watch', '--preserveWatchOutput'], { stdio: ['ignore', 'pipe', 'inherit'], shell: process.platform === 'win32' });
children.push(tsc);
tsc.stdout.on('data', (chunk) => {
  const text = chunk.toString();
  process.stdout.write(text);
  if (!started && /Found 0 errors/.test(text)) {
    started = true;
    run('node', ['--enable-source-maps', '--watch-path=dist', '--watch-preserve-output', `dist/${entry}.js`]);
  }
});
