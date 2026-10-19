import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { build } from 'vite';
const require = createRequire(import.meta.url);
if (process.platform !== 'darwin') throw new Error('VirtualCamera4Mac requires macOS');
const root = fileURLToPath(new URL('.', import.meta.url));
execFileSync(process.execPath, [require.resolve('node-gyp/bin/node-gyp.js'), 'rebuild', '--directory', root], { stdio: 'inherit' });
await build({ configFile: false, root, base: './', logLevel: 'warn',
  build: { outDir: 'build/source', emptyOutDir: true, rollupOptions: { input: `${root}fixture.html` } } });
execFileSync('xcrun', ['clang++', '-std=c++17', '-O2', '-fobjc-arc', '-Wall', '-Wextra', '-Werror',
  `${root}receive.mm`, '-o', `${root}build/receive`, '-framework', 'Foundation',
  '-framework', 'CoreMediaIO', '-framework', 'CoreMedia', '-framework', 'CoreVideo',
  '-framework', 'CoreGraphics', '-framework', 'ImageIO'], { stdio: 'inherit' });
execFileSync('xcrun', ['clang++', '-std=c++17', '-O2', '-fobjc-arc', '-Wall', '-Wextra', '-Werror',
  `${root}gpu-fit-test.mm`, '-o', `${root}build/gpu-fit-test`, '-framework', 'Foundation',
  '-framework', 'Metal', '-framework', 'IOSurface', '-framework', 'CoreVideo'], { stdio: 'inherit' });
console.log('Built native/macos/vc4m/build/{Release/vc4m.node,source/,receive,gpu-fit-test}');
