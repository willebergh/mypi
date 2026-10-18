# Build/install the FaceTime app

Follow the main setup skill's consent/scope rules. Read `extensions/talk/facetime/APP.md` and `Package.swift` in the repository. Requires macOS and Swift 6/Xcode SDK. No developer account is required: default signing is local **ad-hoc**, not notarization.

## Guardrails

- End calls and ask the user to quit the app/CLI **before replacing or rebuilding a running executable**. Do not kill processes or hang up calls to make installation succeed.
- Check the release CLI, any previous `.build/Pi Talk.app` / `.build/Pi FaceTime Bridge.app`, and installed `~/Applications/Pi Talk.app` / legacy `Pi FaceTime Bridge.app`. `lsof` must show no mapped executable. Fail closed on diagnostic/check errors.
- Do not replace a symlink, a non-directory, or an app with a different bundle identifier. Recheck immediately before replacement.
- Keep `dev.mypi.facetime-bridge`, executable `facetime-observer`, and the installed app path stable. Copy the Swift project's [Info.plist](../../../../extensions/talk/facetime/Info.plist); do not invent another identity or add microphone/automation entitlements.
- Assemble/sign/verify a temporary bundle **on the destination filesystem** before moving the old app. Keep a recoverable previous bundle if replacement or verification fails. Never delete the installed app first.
- Do not change TCC/privacy databases, strip quarantine, disable Gatekeeper, create certificates, request Accessibility, or launch the app as a side effect of building.

## Procedure

Run this as one **bash** block from the resolved repository root after approval to install/replace the app. It uses the normal Swift cache; if the release CLI is in use, stop here rather than silently choosing a different cache to bypass the guard. `IDENTITY` stays `-` unless the user explicitly requests an existing local signing identity.

```bash
set -eu
REPO="$(pwd -P)"
[ "$(uname -s)" = Darwin ]
PACKAGE="$REPO/extensions/talk/facetime"
IDENTITY="-"
BIN_DIR="$(swift build --package-path "$PACKAGE" -c release --show-bin-path)"
case "$BIN_DIR" in /*) ;; *) echo 'Expected absolute Swift bin path' >&2; exit 1 ;; esac
APP="$HOME/Applications/Pi Talk.app"
LEGACY_APP="$HOME/Applications/Pi FaceTime Bridge.app"
check_stopped() {
  [ -e "$1" ] || { [ ! -L "$1" ] && return 0; return 1; }
  if FOUND=$(/usr/sbin/lsof -t -- "$1" 2>&1); then
    printf 'Executable in use; quit it before replacing %s\n' "$1" >&2; return 1
  else
    STATUS=$?
    [ "$STATUS" -eq 1 ] && [ -z "$FOUND" ] || { echo 'Cannot verify stopped executable' >&2; return 1; }
  fi
}
validate_app() {
  if [ -L "$APP" ] || [ ! -d "$APP" ]; then echo 'Refusing non-directory or symlinked app' >&2; return 1; fi
  [ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Contents/Info.plist")" = dev.mypi.facetime-bridge ] || { echo 'Refusing unrelated app identity' >&2; return 1; }
  check_stopped "$APP/Contents/MacOS/facetime-observer"
}
HAD_APP=0
if [ -e "$APP" ] || [ -L "$APP" ]; then validate_app; HAD_APP=1; fi
# Guard the old app too; do not silently run two bundles with the same identity.
if [ -e "$LEGACY_APP" ] || [ -L "$LEGACY_APP" ]; then
  [ ! -L "$LEGACY_APP" ] && [ -d "$LEGACY_APP" ] || { echo 'Unsafe legacy app' >&2; exit 1; }
  [ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$LEGACY_APP/Contents/Info.plist")" = dev.mypi.facetime-bridge ] || { echo 'Unrelated legacy app' >&2; exit 1; }
  check_stopped "$LEGACY_APP/Contents/MacOS/facetime-observer"
fi
check_stopped "$BIN_DIR/facetime-observer"
check_stopped "$PACKAGE/.build/Pi FaceTime Bridge.app/Contents/MacOS/facetime-observer"
check_stopped "$PACKAGE/.build/Pi Talk.app/Contents/MacOS/facetime-observer"
swift build --package-path "$PACKAGE" -c release
mkdir -p "$HOME/Applications"
WORK="$(mktemp -d "$HOME/Applications/.pi-facetime.XXXXXX")"
STAGED="$WORK/Pi Talk.app"
BACKUP="$WORK/previous.app"
trap 'if [ -d "$BACKUP" ]; then printf "Previous app preserved at %s\n" "$BACKUP" >&2; else rm -rf "$WORK"; fi' EXIT
mkdir -p "$STAGED/Contents/MacOS"
cp "$PACKAGE/Info.plist" "$STAGED/Contents/Info.plist"
cp "$BIN_DIR/facetime-observer" "$STAGED/Contents/MacOS/facetime-observer"
chmod 755 "$STAGED/Contents/MacOS/facetime-observer"
/usr/bin/plutil -lint "$STAGED/Contents/Info.plist"
/usr/bin/codesign --force --sign "$IDENTITY" --identifier dev.mypi.facetime-bridge --timestamp=none "$STAGED"
/usr/bin/codesign --verify --strict --verbose=2 "$STAGED"
if [ "$HAD_APP" -eq 1 ]; then
  validate_app
  mv "$APP" "$BACKUP"
else
  [ ! -e "$APP" ] && [ ! -L "$APP" ]
fi
if ! mv "$STAGED" "$APP"; then
  if [ -d "$BACKUP" ]; then mv "$BACKUP" "$APP"; fi
  exit 1
fi
/usr/bin/codesign --verify --strict "$APP"
rm -rf "$BACKUP"
printf 'Installed: %s\nNo app was launched or permissions requested.\n' "$APP"
```

When migrating from `Pi FaceTime Bridge.app`, keep the stopped old bundle until the new installation is verified, then ask before archiving/removing the known legacy bundle. Never launch both.

If staging/signing fails, the installed app is untouched. If replacement fails, restore the saved app. If installed verification fails, the exit trap retains the previous bundle; report its path and restore it deliberately before continuing. Do not retry/replay call controls to resolve a build problem.

## Manual activation, only when requested

Open the installed `.app` through LaunchServices (`open "$HOME/Applications/Pi Talk.app"`), **not** `Contents/MacOS/facetime-observer` from a terminal. Check the app menu and have the user grant Accessibility to **Pi Talk**. A changed ad-hoc signature may require quitting, removing/re-adding the apparently enabled entry, reopening, and choosing Start service. Never grant CMUX broad Accessibility to bypass this.

The socket is `~/.local/share/pi-facetime/control.sock`. A read-only snapshot should report trusted Accessibility and `configuration.configPath` matching Pi's `talk.json`. Device selection must verify visible `Pi Talk` for both input and output (or the bridge's exact-UID verification when FaceTime omits the sole/default microphone section). The app is independent: Pi does not auto-launch/restart it. Do not install a LaunchAgent.

For explicit debugging only, the Swift CLI still exists at the release `facetime-observer` path. Read its `--help`; never run its watch service alongside the app, and remember terminal-hosted CLI access may be attributed to the terminal. There is no separate npm wrapper or persisted CLI configuration.
