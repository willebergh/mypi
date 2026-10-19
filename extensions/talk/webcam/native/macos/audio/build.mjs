import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Deliberately independent of native/build.mjs: rebuild ONLY this addon.
if (process.platform !== 'darwin') throw new Error('PiTalk audio requires macOS');
const require = createRequire(import.meta.url);
const directory = fileURLToPath(new URL('.', import.meta.url));
const rootPackage = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'));
let electronVersion;
try {
  electronVersion = require('electron/package.json').version;
} catch {
  electronVersion = rootPackage.devDependencies?.electron ?? rootPackage.dependencies?.electron;
}
if (!/^44\.\d+\.\d+$/.test(electronVersion ?? '')) {
  throw new Error(`Expected an exact Electron 44 version in node_modules/electron or root package.json; got ${electronVersion}`);
}
const args = [require.resolve('node-gyp/bin/node-gyp.js'), 'rebuild', '--directory', directory,
  `--target=${electronVersion}`, '--dist-url=https://electronjs.org/headers'];
// Optional offline headers. Only stable Node-API v8 is used, not V8/Node ABI APIs.
// This also permits cached host Node headers without downloading Electron headers.
if (process.env.PITALK_AUDIO_NODEDIR) args.push(`--nodedir=${process.env.PITALK_AUDIO_NODEDIR}`);
console.log(`Building ONLY pitalk_audio.node for Electron ${electronVersion} (${process.arch}), Node-API v8`);
const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
console.log('Built native/macos/audio/build/Release/pitalk_audio.node (not loaded; capture not started)');
