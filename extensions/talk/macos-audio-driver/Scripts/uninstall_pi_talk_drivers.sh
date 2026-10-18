#!/bin/bash
set -euo pipefail

install_dir="/Library/Audio/Plug-Ins/HAL"
drivers=(PiTalk.driver PiTalkInput.driver PiTalkOutput.driver AgentInput.driver AgentOutput.driver AgentMicrophone.driver AgentHeadphones.driver)

sudo -v
for driver in "${drivers[@]}"; do
    destination="$install_dir/$driver"
    if [[ -e "$destination" ]]; then
        echo "Removing $destination..."
        sudo rm -rf "$destination"
    fi
done

sudo killall coreaudiod 2>/dev/null || true
echo "Pi Talk Audio drivers removed and Core Audio restarted."
