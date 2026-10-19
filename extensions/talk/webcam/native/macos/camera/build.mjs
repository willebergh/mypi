import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

if (process.platform !== 'darwin') process.exit(0);
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('.', import.meta.url));
const build = path.join(root, 'build');
const team = process.env.CAMERA_TEAM_ID || 'UNSIGNED';
const group = process.env.CAMERA_APP_GROUP || `${team}.com.pitalk.webcam`;
if (!/^[A-Z0-9]+$/.test(team) || !/^[A-Za-z0-9.-]+$/.test(group)) throw new Error('Invalid public team/group identifier');
const version = process.env.CAMERA_BUILD_VERSION || '1';
if (!/^\d+(\.\d+){0,2}$/.test(version)) throw new Error('CAMERA_BUILD_VERSION must be a numeric CFBundleVersion');
const bundleID = 'com.pitalk.webcam.camera';
const bundle = path.join(build, `${bundleID}.systemextension`);
mkdirSync(path.join(bundle, 'Contents/MacOS'), { recursive: true });
execFileSync(process.execPath, [require.resolve('node-gyp/bin/node-gyp.js'), 'rebuild', '--directory', path.join(root, 'manager')], { stdio: 'inherit' });
const substitutions = {
  '__BUNDLE_ID__': bundleID, '__TEAM_ID__': team, '__APP_GROUP__': group,
  '__VERSION__': '0.1.0', '__BUILD_VERSION__': version,
  '__MACH_SERVICE__': `${group}.camera`,
};
for (const [input, output] of [['Info.plist', 'Contents/Info.plist'], ['extension.entitlements', '../extension.entitlements']]) {
  let text = readFileSync(path.join(root, 'extension', input), 'utf8');
  for (const [key, value] of Object.entries(substitutions)) text = text.replaceAll(key, value);
  if (/__[A-Z_]+__/.test(text)) throw new Error(`Unresolved plist token: ${input}`);
  writeFileSync(path.resolve(bundle, output), text);
}
const sdk = execFileSync('xcrun', ['--sdk', 'macosx', '--show-sdk-path'], { encoding: 'utf8' }).trim();
const sources = readdirSync(path.join(root, 'extension')).filter(name => name.endsWith('.swift')).map(name => path.join(root, 'extension', name));
execFileSync('xcrun', ['swiftc', '-O', '-swift-version', '6', '-warnings-as-errors', '-parse-as-library', '-emit-executable', '-Xlinker', '-no_adhoc_codesign', '-sdk', sdk,
  '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macosx12.3`,
  ...sources, '-o', path.join(bundle, 'Contents/MacOS', bundleID)], { stdio: 'inherit' });
execFileSync('plutil', ['-lint', path.join(bundle, 'Contents/Info.plist')], { stdio: 'inherit' });
writeFileSync(path.join(build, 'build-config.json'), JSON.stringify({ team, group, bundleID }, null, 2));
console.log(`Camera extension compiled (${team === 'UNSIGNED' ? 'UNSIGNED: cannot activate' : 'not yet signed'})`);
