import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
const profile = process.env.CAMERA_NOTARY_PROFILE;
if (!profile) throw new Error('Set CAMERA_NOTARY_PROFILE to a notarytool credential profile already stored in your own Keychain. Do not put passwords or private keys in this project.');
const app = path.resolve(process.env.CAMERA_APP_PATH || `out/pi-talk-webcam-darwin-${process.arch}/pi-talk-webcam.app`);
const archive = `${app}.zip`;
const signature = spawnSync('codesign', ['-dv', '--verbose=4', app], { encoding: 'utf8' });
if (signature.status !== 0 || !signature.stderr.includes('Authority=Developer ID Application:')) {
  throw new Error('Normal notarized distribution requires a Developer ID Application signature, not Apple Development or ad-hoc signing.');
}
const run = (command, args) => execFileSync(command, args, { stdio: 'inherit' });
run('codesign', ['--verify', '--deep', '--strict', app]);
run('ditto', ['-c', '-k', '--keepParent', app, archive]);
run('xcrun', ['notarytool', 'submit', archive, '--keychain-profile', profile, '--wait']);
run('xcrun', ['stapler', 'staple', app]);
run('xcrun', ['stapler', 'validate', app]);
run('spctl', ['--assess', '--type', 'execute', '--verbose=2', app]);
console.log('Notarized and assessed. Installation and extension approval are still explicit user actions.');
