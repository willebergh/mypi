#!/bin/bash
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"

if [[ $# -ge 1 ]]; then
    build_dir="$1"
elif [[ -d "$script_dir/PiTalk.driver" ]]; then
    # Support the self-contained distributable directory.
    build_dir="$script_dir"
else
    build_dir="$repo_root/dist/pi-talk-macos-audio-driver"
fi

install_dir="/Library/Audio/Plug-Ins/HAL"
drivers=(PiTalk.driver)
legacy_drivers=(PiTalkInput.driver PiTalkOutput.driver AgentInput.driver AgentOutput.driver AgentMicrophone.driver AgentHeadphones.driver)
all_managed=("${drivers[@]}" "${legacy_drivers[@]}")

for driver in "${drivers[@]}"; do
    if [[ ! -d "$build_dir/$driver" ]]; then
        echo "error: $build_dir/$driver does not exist" >&2
        echo "Build from the component root with ./Scripts/build_pi_talk_drivers.sh (or from this package's Source directory)." >&2
        exit 1
    fi
    codesign --verify --deep --strict "$build_dir/$driver"
done

echo "Close audio applications before continuing."
echo "Installing the Pi Talk Audio drivers in $install_dir..."
sudo -v
sudo mkdir -p "$install_dir"

staging_dir="$install_dir/.pi-talk-staging.$$"
backup_dir="$install_dir/.pi-talk-backup.$$"
transaction_started=false
transaction_complete=false

cleanup() {
    if [[ "$transaction_started" == true && "$transaction_complete" != true ]]; then
        echo "Installation failed; restoring the previous drivers..." >&2
        for driver in "${all_managed[@]}"; do
            sudo rm -rf "$install_dir/$driver"
            if [[ -d "$backup_dir/$driver" ]]; then
                sudo ditto "$backup_dir/$driver" "$install_dir/$driver"
            fi
        done
    fi
    sudo rm -rf "$staging_dir" "$backup_dir"
}
trap cleanup EXIT

sudo mkdir -p "$staging_dir" "$backup_dir"

# Prepare and verify complete replacements before touching installed drivers.
for driver in "${drivers[@]}"; do
    sudo ditto "$build_dir/$driver" "$staging_dir/$driver"
    sudo chown -R root:wheel "$staging_dir/$driver"
    sudo chmod -R go-w "$staging_dir/$driver"
    sudo xattr -dr com.apple.quarantine "$staging_dir/$driver" 2>/dev/null || true
    codesign --verify --deep --strict "$staging_dir/$driver"
done

# Back up all managed bundles before beginning the replacement transaction.
for driver in "${all_managed[@]}"; do
    if [[ -d "$install_dir/$driver" ]]; then
        sudo ditto "$install_dir/$driver" "$backup_dir/$driver"
    fi
done
transaction_started=true

for driver in "${all_managed[@]}"; do
    sudo rm -rf "$install_dir/$driver"
done
for driver in "${drivers[@]}"; do
    sudo mv "$staging_dir/$driver" "$install_dir/$driver"
done

transaction_complete=true
cleanup
trap - EXIT

echo "Restarting Core Audio..."
sudo killall coreaudiod 2>/dev/null || true

echo
echo "Installation complete. Reopen Audio MIDI Setup or your audio applications."
