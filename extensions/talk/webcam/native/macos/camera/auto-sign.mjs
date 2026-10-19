// Uses Xcode's existing signed-in account. Never reads account tokens or exports keys.
// The host target stages the EXISTING Electron app; no second user-facing app.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

if (process.platform !== 'darwin') throw new Error('Xcode automatic signing requires macOS');
const root = fileURLToPath(new URL('.', import.meta.url));
const directory = path.join(root, 'build/automatic-signing');
mkdirSync(directory, { recursive: true });
const run = (command, args) => execFileSync(command, args, { encoding: 'utf8' }).trim();
const teams = JSON.parse(run('python3', ['-c', `
import pathlib,plistlib,json
p=pathlib.Path.home()/'Library/Preferences/com.apple.dt.Xcode.plist'
d=plistlib.load(p.open('rb')).get('IDEProvisioningTeamByIdentifier',{})
result=[]
def walk(x):
 if isinstance(x,dict):
  if 'teamID' in x: result.append({k:x[k] for k in ('teamID','teamName','isFreeProvisioningTeam','teamType') if k in x})
  else:
   for v in x.values(): walk(v)
 elif isinstance(x,list):
  for v in x: walk(v)
walk(d)
print(json.dumps(result))
`]));
console.log('Configured Xcode teams:', JSON.stringify(teams, null, 2));
const team = process.env.CAMERA_TEAM_ID || (teams.length === 1 ? teams[0].teamID : null);
if (!team || !/^[A-Z0-9]{10}$/.test(team)) throw new Error('Select your public Team ID using CAMERA_TEAM_ID; no credentials are needed');
console.log(run('security', ['find-identity', '-v', '-p', 'codesigning']));
const app = path.resolve(process.env.CAMERA_APP_PATH || `out/pi-talk-webcam-darwin-${process.arch}/pi-talk-webcam.app`);
if (!existsSync(app)) throw new Error('Run pnpm package first; the real Electron host must exist');
const group = `${team}.com.pitalk.webcam`;
const plist = (name, value) => execFileSync('plutil', ['-convert', 'xml1', '-o', path.join(directory, name), '-'], { input: JSON.stringify(value) });
plist('Host.entitlements', {
  'com.apple.developer.system-extension.install': true,
  'com.apple.security.application-groups': [group],
  'com.apple.security.cs.allow-jit': true,
});
plist('Camera.entitlements', {
  'com.apple.security.app-sandbox': true,
  'com.apple.security.application-groups': [group],
});
let cameraInfo = readFileSync(path.join(root, 'extension/Info.plist'), 'utf8');
for (const [key, value] of Object.entries({ __BUNDLE_ID__: 'com.pitalk.webcam.camera', __TEAM_ID__: team,
  __VERSION__: '0.1.0', __BUILD_VERSION__: '1', __MACH_SERVICE__: `${group}.camera` })) {
  cameraInfo = cameraInfo.replaceAll(key, value);
}
writeFileSync(path.join(directory, 'Camera-Info.plist'), cameraInfo);
// A generated .xcodeproj avoids another framework/project dependency. Sources stay in extension/.
let sequence = 1;
const id = () => (sequence++).toString(16).padStart(24, '0').toUpperCase();
const objects = [];
const object = (identifier, body) => objects.push(`${identifier} = { ${body} };`);
const q = JSON.stringify;
const project = id(), mainGroup = id(), products = id();
const host = id(), camera = id(), hostProduct = id(), cameraProduct = id();
const hostConfigs = id(), cameraConfigs = id(), projectConfigs = id();
const sourcePhase = id(), hostPhase = id(), dependency = id(), proxy = id();
const sourceIDs = [];
for (const name of ['TestPattern.swift', 'FramePump.swift', 'Provider.swift', 'main.swift']) {
  const file = id(), build = id();
  object(file, `isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = ${q(path.join(root, 'extension', name))}; sourceTree = "<absolute>";`);
  object(build, `isa = PBXBuildFile; fileRef = ${file};`);
  sourceIDs.push([file, build]);
}
object(hostProduct, 'isa = PBXFileReference; explicitFileType = wrapper.application; path = "pi-talk-webcam.app"; sourceTree = BUILT_PRODUCTS_DIR;');
object(cameraProduct, 'isa = PBXFileReference; explicitFileType = "wrapper.system-extension"; path = "com.pitalk.webcam.camera.systemextension"; sourceTree = BUILT_PRODUCTS_DIR;');
object(products, `isa = PBXGroup; children = (${hostProduct}, ${cameraProduct}); name = Products; sourceTree = "<group>";`);
object(mainGroup, `isa = PBXGroup; children = (${products}, ${sourceIDs.map(s => s[0]).join(',')}); sourceTree = "<group>";`);
object(sourcePhase, `isa = PBXSourcesBuildPhase; buildActionMask = 2147483647; files = (${sourceIDs.map(s => s[1]).join(',')}); runOnlyForDeploymentPostprocessing = 0;`);
const shell = 'set -eu\n/usr/bin/ditto "$PI_TALK_SOURCE_APP" "$TARGET_BUILD_DIR/$FULL_PRODUCT_NAME"\nmkdir -p "$TARGET_BUILD_DIR/$FULL_PRODUCT_NAME/Contents/Library/SystemExtensions"\n/usr/bin/ditto "$BUILT_PRODUCTS_DIR/com.pitalk.webcam.camera.systemextension" "$TARGET_BUILD_DIR/$FULL_PRODUCT_NAME/Contents/Library/SystemExtensions/com.pitalk.webcam.camera.systemextension"\n';
object(hostPhase, `isa = PBXShellScriptBuildPhase; buildActionMask = 2147483647; files = (); inputPaths = (); outputPaths = (); runOnlyForDeploymentPostprocessing = 0; shellPath = /bin/sh; shellScript = ${q(shell)}; name = "Stage existing Electron host"; alwaysOutOfDate = 1;`);
object(proxy, `isa = PBXContainerItemProxy; containerPortal = ${project}; proxyType = 1; remoteGlobalIDString = ${camera}; remoteInfo = CameraExtension;`);
object(dependency, `isa = PBXTargetDependency; target = ${camera}; targetProxy = ${proxy};`);
object(camera, `isa = PBXNativeTarget; name = CameraExtension; productName = "com.pitalk.webcam.camera"; productReference = ${cameraProduct}; productType = "com.apple.product-type.system-extension"; buildConfigurationList = ${cameraConfigs}; buildPhases = (${sourcePhase}); buildRules = (); dependencies = ();`);
object(host, `isa = PBXNativeTarget; name = ElectronHost; productName = "pi-talk-webcam"; productReference = ${hostProduct}; productType = "com.apple.product-type.application"; buildConfigurationList = ${hostConfigs}; buildPhases = (${hostPhase}); buildRules = (); dependencies = (${dependency});`);
function configurations(list, settings) {
  const config = id();
  object(config, `isa = XCBuildConfiguration; name = Debug; buildSettings = { ${Object.entries(settings).map(([k,v]) => `${k} = ${q(v)};`).join(' ')} };`);
  object(list, `isa = XCConfigurationList; buildConfigurations = (${config}); defaultConfigurationIsVisible = 0; defaultConfigurationName = Debug;`);
}
configurations(projectConfigs, { SDKROOT: 'macosx', MACOSX_DEPLOYMENT_TARGET: '12.3', SWIFT_VERSION: '6.0',
  CODE_SIGN_STYLE: 'Automatic', DEVELOPMENT_TEAM: team, CODE_SIGN_IDENTITY: 'Apple Development',
  ONLY_ACTIVE_ARCH: 'YES', ARCHS: process.arch === 'arm64' ? 'arm64' : 'x86_64',
  ALWAYS_SEARCH_USER_PATHS: 'NO', ENABLE_USER_SCRIPT_SANDBOXING: 'NO' });
configurations(cameraConfigs, { PRODUCT_NAME: 'com.pitalk.webcam.camera', PRODUCT_BUNDLE_IDENTIFIER: 'com.pitalk.webcam.camera',
  INFOPLIST_FILE: 'Camera-Info.plist', CODE_SIGN_ENTITLEMENTS: 'Camera.entitlements',
  SWIFT_ACTIVE_COMPILATION_CONDITIONS: 'DEBUG', OTHER_SWIFT_FLAGS: '-parse-as-library',
  ENABLE_APP_SANDBOX: 'YES', ENABLE_HARDENED_RUNTIME: 'YES', SKIP_INSTALL: 'YES' });
configurations(hostConfigs, { PRODUCT_NAME: 'pi-talk-webcam', PRODUCT_BUNDLE_IDENTIFIER: 'com.pitalk.webcam',
  INFOPLIST_FILE: path.join(app, 'Contents/Info.plist'), CODE_SIGN_ENTITLEMENTS: 'Host.entitlements',
  PI_TALK_SOURCE_APP: app, ENABLE_HARDENED_RUNTIME: 'YES' });
object(project, `isa = PBXProject; attributes = { LastUpgradeCheck = 2710; TargetAttributes = {
  ${host} = { DevelopmentTeam = ${q(team)}; ProvisioningStyle = Automatic; SystemCapabilities = { "com.apple.SystemExtension" = { enabled = 1; }; "com.apple.ApplicationGroups.iOS" = { enabled = 1; }; }; };
  ${camera} = { DevelopmentTeam = ${q(team)}; ProvisioningStyle = Automatic; SystemCapabilities = { "com.apple.ApplicationGroups.iOS" = { enabled = 1; }; "com.apple.Sandbox" = { enabled = 1; }; }; };
}; }; buildConfigurationList = ${projectConfigs}; compatibilityVersion = "Xcode 14.0"; developmentRegion = en; hasScannedForEncodings = 0; knownRegions = (en, Base); mainGroup = ${mainGroup}; productRefGroup = ${products}; projectDirPath = ""; projectRoot = ""; targets = (${host}, ${camera});`);
const projectDir = path.join(directory, 'PiTalkSigning.xcodeproj');
mkdirSync(projectDir, { recursive: true });
writeFileSync(path.join(projectDir, 'project.pbxproj'), `// !$*UTF8*$!\n{ archiveVersion = 1; classes = {}; objectVersion = 56; objects = {\n${objects.join('\n')}\n}; rootObject = ${project}; }\n`);
console.log(`Automatic development signing configured: team ${team}, host + camera, System Extension + shared App Group.`);
if (process.argv.includes('--configure-only')) { console.log(projectDir); process.exit(0); }
const target = process.argv.includes('--extension-only') ? 'CameraExtension' : 'ElectronHost';
const label = target === 'CameraExtension' ? 'camera' : 'host';
const args = ['-project', projectDir, '-target', target, '-configuration', 'Debug',
  '-allowProvisioningUpdates', '-allowProvisioningDeviceRegistration',
  `SYMROOT=${path.join(directory, 'products')}`, `OBJROOT=${path.join(directory, 'intermediates')}`, 'build'];
console.log('Running xcodebuild with the existing Xcode account; no installation/activation request.');
const result = spawnSync('xcodebuild', args, { encoding: 'utf8', timeout: 180000, maxBuffer: 20 * 1024 * 1024 });
const log = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
writeFileSync(path.join(directory, `${label}-xcodebuild.log`), log);
console.log(log);
writeFileSync(path.join(directory, `${label}-attempt.json`), JSON.stringify({ target, team: teams.find(t => t.teamID === team) ?? { teamID: team },
  exitCode: result.status, signal: result.signal, error: result.error?.message ?? null,
  project: projectDir, args, installed: false, activated: false }, null, 2));
if (result.status === 0) {
  console.log(target === 'CameraExtension'
    ? 'Camera extension signed. This does NOT grant the host System Extension installation entitlement; no activation performed.'
    : 'Xcode build succeeded. STOP: inspect embedded profiles/entitlements and finish nested Electron signing/validation before installation. This staging product is NOT yet an installation-ready deliverable.');
} else {
  console.error(`Automatic signing/provisioning did not succeed. No install or security-setting commands performed. See ${label}-xcodebuild.log.`);
}
process.exit(result.status ?? 1);
