// Explicit user-run signing only. No key export, password argument or security bypass.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { sign } from '@electron/osx-sign';

const team = process.env.CAMERA_TEAM_ID;
const identity = process.env.CAMERA_SIGN_IDENTITY;
const hostProfile = process.env.CAMERA_HOST_PROFILE;
const extensionProfile = process.env.CAMERA_EXTENSION_PROFILE;
const distribution = process.env.CAMERA_SIGNING_TYPE === 'distribution';
const app = path.resolve(process.env.CAMERA_APP_PATH || `out/pi-talk-webcam-darwin-${process.arch}/pi-talk-webcam.app`);
const build = path.resolve('native/macos/camera/build');
const extension = path.join(app, 'Contents/Library/SystemExtensions/com.pitalk.webcam.camera.systemextension');
const run = (command, args, options = {}) => execFileSync(command, args, { encoding: 'utf8', ...options });
function extract(xml, key, format = 'raw', optional = false) {
  try { return run('plutil', ['-extract', key, format, '-o', '-', '-'], { input: xml, stdio: ['pipe', 'pipe', 'pipe'] }).trim(); }
  catch (error) { if (optional) return null; throw new Error(`Provisioning profile lacks ${key}`); }
}
function profile(filename, bundleID, install) {
  if (!existsSync(filename)) throw new Error(`Provisioning profile file not found: ${filename}`);
  const xml = run('security', ['cms', '-D', '-i', filename], { stdio: ['ignore', 'pipe', 'pipe'] });
  const entitlements = JSON.parse(extract(xml, 'Entitlements', 'json'));
  const id = entitlements['com.apple.application-identifier'] || entitlements['application-identifier'];
  if (id !== `${team}.${bundleID}` || entitlements['com.apple.developer.team-identifier'] !== team) {
    throw new Error(`Profile does not authorize team ${team} and exact bundle ID ${bundleID}`);
  }
  const expiry = new Date(extract(xml, 'ExpirationDate')).getTime();
  if (!Number.isFinite(expiry) || expiry <= Date.now()) throw new Error('Provisioning profile expired or has invalid expiration');
  const certificates = xml.match(/<key>DeveloperCertificates<\/key>\s*<array>([\s\S]*?)<\/array>/)?.[1] ?? '';
  const fingerprints = [...certificates.matchAll(/<data>([\s\S]*?)<\/data>/g)].map(match =>
    createHash('sha1').update(Buffer.from(match[1].replace(/\s/g, ''), 'base64')).digest('hex').toUpperCase());
  if (!fingerprints.includes(identityFingerprint)) throw new Error('Selected local signing certificate is not authorized by this provisioning profile');
  if (install && entitlements['com.apple.developer.system-extension.install'] !== true) {
    throw new Error('Host profile must authorize com.apple.developer.system-extension.install. Enable System Extension for the host App ID and regenerate it.');
  }
  const devices = extract(xml, 'ProvisionedDevices', 'json', true);
  if (devices) {
    const hardware = run('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice']);
    const uuid = hardware.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/)?.[1];
    if (!uuid || !JSON.parse(devices).some(device => device.toUpperCase() === uuid.toUpperCase())) {
      throw new Error('This Mac is not included in the device-limited provisioning profile');
    }
  }
  return entitlements;
}
function plist(filename, object) {
  run('plutil', ['-convert', 'xml1', '-o', filename, '-'], { input: JSON.stringify(object) });
}
if (!team || !identity || !hostProfile) {
  throw new Error('Signing blocked. Set CAMERA_TEAM_ID, CAMERA_SIGN_IDENTITY (local certificate name/SHA-1) and CAMERA_HOST_PROFILE (file path). See native/macos/camera/README.md. No private keys/passwords should be provided.');
}
if (!/^[A-Z0-9]{10}$/.test(team)) throw new Error('CAMERA_TEAM_ID must be the public 10-character Team ID');
if (!existsSync(extension)) throw new Error('Package the app before signing (pnpm package)');
const config = JSON.parse(readFileSync(path.join(build, 'build-config.json'), 'utf8'));
if (config.team !== team) throw new Error('Rebuild pnpm package with the same CAMERA_TEAM_ID environment; the embedded Mach service must match');
const identities = run('security', ['find-identity', '-v', '-p', 'codesigning']);
const chosen = [...identities.matchAll(/([A-F0-9]{40}) "([^"]+)"/g)].find(match => match[1] === identity.toUpperCase() || match[2] === identity);
if (!chosen) throw new Error('Requested code-signing identity is not available in the local keychain');
const identityFingerprint = chosen[1];
const hostEntitlements = profile(hostProfile, 'com.pitalk.webcam', true);
if (extensionProfile) profile(extensionProfile, 'com.pitalk.webcam.camera', false);
if (process.argv.includes('--check')) {
  console.log('Profile/bundle preflight passed. No signing or installation performed. Certificate/profile matching is also checked by codesign/macOS.');
  process.exit(0);
}
const rootEntitlements = {
  'com.apple.developer.system-extension.install': true,
  'com.apple.security.application-groups': [config.group],
  'com.apple.application-identifier': hostEntitlements['com.apple.application-identifier'] || hostEntitlements['application-identifier'],
  'com.apple.developer.team-identifier': team,
  'com.apple.security.cs.allow-jit': true,
};
const rootEnt = path.join(build, 'host.entitlements');
const helperEnt = path.join(build, 'electron-helper.entitlements');
const emptyEnt = path.join(build, 'library.entitlements');
plist(rootEnt, rootEntitlements);
plist(helperEnt, { 'com.apple.security.cs.allow-jit': true });
plist(emptyEnt, {});
copyFileSync(hostProfile, path.join(app, 'Contents/embedded.provisionprofile'));
if (extensionProfile) copyFileSync(extensionProfile, path.join(extension, 'Contents/embedded.provisionprofile'));
let extensionEnt = readFileSync(path.join(build, 'extension.entitlements'), 'utf8');
if (extensionProfile) {
  const parsed = JSON.parse(run('plutil', ['-convert', 'json', '-o', '-', '-'], { input: extensionEnt }));
  parsed['com.apple.application-identifier'] = `${team}.com.pitalk.webcam.camera`;
  parsed['com.apple.developer.team-identifier'] = team;
  plist(path.join(build, 'extension-sign.entitlements'), parsed);
} else writeFileSync(path.join(build, 'extension-sign.entitlements'), extensionEnt);
run('plutil', ['-replace', 'ElectronTeamID', '-string', team, path.join(app, 'Contents/Info.plist')]);
console.log('Signing with the existing local keychain identity. If macOS asks, you must approve access yourself.');
run('codesign', ['--force', '--sign', identity, '--options', 'runtime', distribution ? '--timestamp' : '--timestamp=none',
  '--entitlements', path.join(build, 'extension-sign.entitlements'), extension], { stdio: 'inherit' });
await sign({ app, identity, platform: 'darwin', type: distribution ? 'distribution' : 'development',
  preAutoEntitlements: false, preEmbedProvisioningProfile: false,
  ignore: file => file.includes('.systemextension'),
  optionsForFile: file => ({ entitlements: file === app ? rootEnt : file.endsWith('.app') ? helperEnt : emptyEnt,
    hardenedRuntime: true, timestamp: distribution ? undefined : 'none' }),
});
run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], { stdio: 'inherit' });
console.log('Signed, not installed or activated. Distribution builds still require notarization. Move the app to /Applications yourself, launch it there, and click Install / Activate.');
