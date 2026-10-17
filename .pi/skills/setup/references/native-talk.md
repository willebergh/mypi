# Build the native Talk helper

Follow the main setup skill's consent/scope rules. macOS arm64/x64 only. Resolve the repository from the skill, not the user's project. Read `extensions/talk/native/README.md`, `rust-toolchain.toml`, and `Cargo.toml` before building. Source/license notices stay intact.

## Preflight

- Xcode command-line tools/macOS SDK: `xcrun --show-sdk-path`.
- Node architecture: `node -p process.arch` must be `arm64` or `x64`.
- `rustup toolchain list` must already contain the **checked-in pin** (currently 1.99.0). Ask before installing a missing toolchain: `rustup toolchain install VERSION --profile minimal`. Never change the global default. Do not use `rustup show` as an install-free probe; it may install a selected toolchain.
- `cargo` must be rustup's proxy. After removing `RUSTUP_TOOLCHAIN` in the subshell below, `cargo --version` must match the pin; stop if not.
- Installed `pkg-config` and static Opus (`libopus.a`); with approval on Homebrew: `brew install opus pkg-config`. Prefer installed Opus rather than audiopus_sys's CMake fallback. A custom Opus installation is fine when discoverable by pkg-config.
- End audio sessions and quit helpers before replacing binaries. **Do not stop them automatically.** Inspect `lsof` for both the Cargo release executable and the delivered helper. PIDs mean stop; an unexpected exit/error means the check failed, not that the file is unused. Recheck before publication.

## Build and publish

Run the following as one **bash** block from the resolved repository root, only after preflight. It changes environment only in this shell and copies the artifact atomically. Cargo can download locked dependencies; it does not receive AI credentials from this procedure.

```bash
set -eu
REPO="$(pwd -P)"
cd "$REPO/extensions/talk/native"
ARCH="$(node -p process.arch)"
case "$ARCH" in arm64|x64) ;; *) echo 'Unsupported Node architecture' >&2; exit 1 ;; esac
[ "$(uname -s)" = Darwin ]
unset RUSTUP_TOOLCHAIN CARGO_BUILD_TARGET LIBOPUS_NO_PKG OPUS_NO_PKG OPUS_NO_PKG_CONFIG
export CARGO_TARGET_DIR="$PWD/target" OPUS_STATIC=1
if ! pkg-config --exists opus; then
  OPUS_PREFIX="$(brew --prefix opus)"
  export PKG_CONFIG_PATH="$OPUS_PREFIX/lib/pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"
fi
pkg-config --modversion opus
test -f "$(pkg-config --variable=libdir opus)/libopus.a"
cargo --version
DEST="$PWD/bin/darwin-$ARCH/pi-codex-voice"
check_stopped() {
  [ -e "$1" ] || { [ ! -L "$1" ] && return 0; return 1; }
  if FOUND=$(/usr/sbin/lsof -t -- "$1" 2>&1); then
    printf 'Executable in use; end the session before replacing %s\n' "$1" >&2; return 1
  else
    STATUS=$?
    [ "$STATUS" -eq 1 ] && [ -z "$FOUND" ] || { echo 'Cannot verify stopped executable' >&2; return 1; }
  fi
}
check_stopped "$PWD/target/release/pi-codex-voice"
check_stopped "$DEST"
cargo build --release --locked
mkdir -p "$(dirname "$DEST")"
TEMP="$(mktemp "$(dirname "$DEST")/.pi-codex-voice.XXXXXX")"
trap 'rm -f "$TEMP"' EXIT
cp "$PWD/target/release/pi-codex-voice" "$TEMP"
chmod 755 "$TEMP"
file "$TEMP"
case "$ARCH:$(/usr/bin/lipo -archs "$TEMP")" in
  arm64:arm64|x64:x86_64) ;;
  *) echo 'Mach-O architecture does not match Node; not publishing' >&2; exit 1 ;;
esac
check_stopped "$DEST"
mv -f "$TEMP" "$DEST"
```

The block checks the Mach-O architecture against Node before publication. Do not bypass this check or accept a Rosetta/target mismatch merely because Cargo succeeded. The destination must be `extensions/talk/native/bin/darwin-<Node arch>/pi-codex-voice`; runtime resolves it relative to the extension.

Keep existing artifacts if compilation fails. Do not fall back to another architecture, system-default audio, a downloaded third-party executable, or a runtime rebuild. A microphone/live `/talk` test is a separate user-approved step, not part of compilation.
