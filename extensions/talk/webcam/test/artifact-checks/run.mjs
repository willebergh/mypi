#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { copyFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const output = path.join(root, 'artifacts/artifact-checks');
const checks = ['aspect-resize-smoke', 'hud-close-check', 'speech-mouth-check', 'hud-capture', 'desk-capture', 'character-capture', 'closed-pipe-smoke'];
const args = process.argv.slice(2);
const buildOnly = args.includes('--build-only');
const names = args.filter(arg => arg !== '--build-only');
if (names.length !== 1 || (names[0] !== 'all' && !checks.includes(names[0])) || (names[0] === 'all' && !buildOnly)) {
  console.error(`Usage: node test/artifact-checks/run.mjs <${checks.join('|')}|all> [--build-only]\n'all' requires --build-only; execution is always explicitly selected.`);
  process.exit(1);
}
const selected = names[0] === 'all' ? checks : names;
process.chdir(root);
mkdirSync(output, { recursive: true });

// Import lazily: the preserved Node-only closed-pipe snapshot needs no Vite/Electron.
let vite;
async function buildMain(entry, filename) {
  vite ??= await import('vite');
  await vite.build({
    configFile: false, root, logLevel: 'warn',
    build: {
      ssr: entry, target: 'node22', outDir: output, emptyOutDir: false,
      minify: false, rollupOptions: {
        external: ['electron'], output: { format: 'cjs', entryFileNames: filename },
      },
    },
  });
}
const gpuChecks = selected.filter(name => name !== 'closed-pipe-smoke');
if (gpuChecks.some(name => name !== 'aspect-resize-smoke')) {
  vite ??= await import('vite');
  await vite.build({
    configFile: false, root, base: './', logLevel: 'warn',
    build: {
      outDir: output, emptyOutDir: false, minify: false,
      lib: { entry: path.join(here, 'hud-capture-renderer.ts'), name: 'HudCapture', formats: ['iife'], fileName: () => 'hud-capture-renderer.js' },
    },
  });
  // The HTML's plain script tag matches the IIFE above, including file:// use.
  copyFileSync(path.join(here, 'hud-capture.html'), path.join(output, 'hud-capture.html'));
}
for (const name of gpuChecks) await buildMain(path.join(here, `${name}.ts`), `${name}.cjs`);
if (selected.includes('aspect-resize-smoke')) {
  // OffscreenRenderer resolves preload.cjs beside its generated main bundle.
  await buildMain(path.join(root, 'src/preload/index.ts'), 'preload.cjs');
}
if (selected.includes('closed-pipe-smoke')) copyFileSync(path.join(here, 'closed-pipe-smoke.cjs'), path.join(output, 'closed-pipe-smoke.cjs'));
if (buildOnly) {
  console.log(`Built ${selected.join(', ')} in ${output}; no runtime launched.`);
  process.exit(0);
}

const name = selected[0];
const closedPipe = name === 'closed-pipe-smoke';
if (!closedPipe && process.env.VC4M_OUTPUT === '1') throw new Error('Unset VC4M_OUTPUT: these fixtures must not publish camera output.');
const logDirectory = path.join(root, 'artifacts/closed-pipe-smoke');
if (closedPipe) {
  mkdirSync(logDirectory, { recursive: true });
  rmSync(path.join(logDirectory, 'main-errors.log'), { force: true });
}
const require = createRequire(import.meta.url);
const executable = closedPipe ? process.execPath : require('electron');
const env = { ...process.env, LOG_TEST_DIR: logDirectory };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(executable, [path.join(output, `${name}.cjs`)], {
  cwd: root, env, stdio: closedPipe ? ['ignore', 'pipe', 'pipe'] : 'inherit',
});
// Remove both readers before the fixture's delayed console writes.
if (closedPipe) { child.stdout.destroy(); child.stderr.destroy(); }
const code = await new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('exit', (code, signal) => signal ? reject(new Error(`Fixture terminated by ${signal}`)) : resolve(code));
});
if (code !== 0) process.exit(code ?? 1);
if (closedPipe && !readFileSync(path.join(logDirectory, 'main-errors.log'), 'utf8').includes('closed-pipe-smoke')) {
  throw new Error('Closed-pipe fixture did not persist its error marker');
}
console.log(`${name}: passed`);
