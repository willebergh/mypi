import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') {
  console.log('Native Metal bridge: skipped (macOS only)');
} else {
  const require = createRequire(import.meta.url);
  const result = spawnSync(process.execPath, [require.resolve('node-gyp/bin/node-gyp.js'),
    'rebuild', '--directory', fileURLToPath(new URL('./macos', import.meta.url))], { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}
