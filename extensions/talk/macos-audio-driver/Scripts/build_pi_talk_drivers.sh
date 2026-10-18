#!/bin/bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
output_dir="$repo_root/dist/pi-talk-macos-audio-driver"
work_dir="$repo_root/build/pi-talk-macos-audio-driver"
original_factory_uuid="e395c745-4eea-4d94-bb92-46224221047c"
version="$(tr -d '[:space:]' < "$repo_root/VERSION")"
build_number="$(tr -d '[:space:]' < "$repo_root/BUILD_NUMBER")"

if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "error: VERSION must contain a three-part numeric version" >&2
    exit 1
fi
if [[ ! "$build_number" =~ ^[0-9]+$ ]]; then
    echo "error: BUILD_NUMBER must contain an integer" >&2
    exit 1
fi

if [[ $# -ne 0 ]]; then
    echo "error: this script does not accept an output path; output is always dist/pi-talk-macos-audio-driver" >&2
    exit 2
fi

command -v xcodebuild >/dev/null || {
    echo "error: Xcode command-line tools are required" >&2
    exit 1
}
command -v python3 >/dev/null || {
    echo "error: Python 3 is required to build the icon" >&2
    exit 1
}

rm -rf "$work_dir" "$output_dir"
mkdir -p "$work_dir" "$output_dir"
"$repo_root/Scripts/build_pi_talk_icon.py" "$repo_root/BlackHole/PiTalkAudio.icns"

build_driver() {
    local bundle_name="$1"
    local bundle_id="$2"
    local driver_name="$3"
    local device_name="$4"
    local factory_uuid="$5"
    local product_dir="$work_dir/$bundle_name-product"
    local settings_header="$work_dir/$bundle_name-settings.h"

    # A generated prefix header avoids Xcode splitting quoted device names at spaces.
    cat > "$settings_header" <<EOF
#define kDriver_Name "$driver_name"
#define kPlugIn_BundleID "$bundle_id"
#define kPlugIn_Icon "PiTalkAudio.icns"
#define kManufacturer_Name "Pi Talk"
#define kHas_Driver_Name_Format false
#define kBox_UID "io.github.willebergh.pitalk.audio.box"
#define kDevice_UID "io.github.willebergh.pitalk.audio.visible"
#define kDevice2_UID "io.github.willebergh.pitalk.audio.internal"
#define kDevice_ModelUID "io.github.willebergh.pitalk.audio.model"
#define kDevice_Name "$device_name"
#define kDevice_IsHidden false
#define kDevice_HasInput true
#define kDevice_HasOutput true
#define kDevice2_Name "Pi Talk Internal"
#define kDevice2_IsHidden true
#define kDevice2_HasInput true
#define kDevice2_HasOutput true
#define kNumber_Of_Channels 2
#define kSampleRates 48000
#define kLatency_Frame_Size 0
EOF

    echo "Building $bundle_name.driver..."
    xcodebuild \
        -project "$repo_root/BlackHole.xcodeproj" \
        -target BlackHole \
        -configuration Release \
        -sdk macosx \
        ARCHS=arm64 \
        ONLY_ACTIVE_ARCH=YES \
        CODE_SIGNING_ALLOWED=NO \
        OBJROOT="$work_dir/$bundle_name-obj" \
        SYMROOT="$work_dir/$bundle_name-sym" \
        CONFIGURATION_BUILD_DIR="$product_dir" \
        PRODUCT_BUNDLE_IDENTIFIER="$bundle_id" \
        PRODUCT_NAME="$bundle_name" \
        MARKETING_VERSION="$version" \
        CURRENT_PROJECT_VERSION="$build_number" \
        GCC_PREFIX_HEADER="$settings_header" \
        GCC_PRECOMPILE_PREFIX_HEADER=NO \
        build

    local source_bundle="$product_dir/$bundle_name.driver"
    local destination_bundle="$output_dir/$bundle_name.driver"
    local plist="$source_bundle/Contents/Info.plist"

    if ! grep -q "$original_factory_uuid" "$plist"; then
        echo "error: expected factory UUID was not found in $plist" >&2
        exit 1
    fi

    # Every installed AudioServer plug-in needs its own stable factory UUID.
    sed "s/$original_factory_uuid/$factory_uuid/g" "$plist" > "$plist.tmp"
    mv "$plist.tmp" "$plist"
    cp "$repo_root/PI_TALK_DRIVER_NOTICE.md" "$source_bundle/Contents/Resources/NOTICE.md"

    # Keep only the exported factory symbol and remove local build paths/debug symbols.
    strip -x "$source_bundle/Contents/MacOS/$bundle_name"

    mv "$source_bundle" "$destination_bundle"
    codesign --force --deep --sign - "$destination_bundle"
    codesign --verify --deep --strict "$destination_bundle"
}

# One bundle exposes the visible call endpoint and the hidden Pi Talk endpoint.
build_driver \
    "PiTalk" \
    "io.github.willebergh.pitalk.audio.driver" \
    "PiTalk" \
    "Pi Talk" \
    "f60d07d7-d527-4a59-bf62-c3c00835a4da"

rm -rf "$work_dir"

# Make the binary package portable and include its exact GPLv3 Corresponding Source.
cp "$repo_root/Scripts/install_pi_talk_drivers.sh" "$output_dir/install.sh"
cp "$repo_root/Scripts/uninstall_pi_talk_drivers.sh" "$output_dir/uninstall.sh"
cp "$repo_root/PI_TALK_AUDIO.md" "$output_dir/README.md"
cp "$repo_root/PI_TALK_DRIVER_NOTICE.md" "$output_dir/NOTICE.md"
cp "$repo_root/LICENSE" "$output_dir/LICENSE"
chmod +x "$output_dir/install.sh" "$output_dir/uninstall.sh"

source_dir="$output_dir/Source"
mkdir -p "$source_dir/BlackHole" "$source_dir/BlackHoleTests" "$source_dir/Scripts"
cp -R "$repo_root/BlackHole.xcodeproj" "$source_dir/BlackHole.xcodeproj"
cp "$repo_root/BlackHole/BlackHole.c" "$source_dir/BlackHole/BlackHole.c"
cp "$repo_root/BlackHoleTests/main.c" "$source_dir/BlackHoleTests/main.c"
cp "$repo_root/BlackHole/BlackHole.plist" "$source_dir/BlackHole/BlackHole.plist"
cp "$repo_root/BlackHole/PiTalkAudioIcon.png" "$source_dir/BlackHole/PiTalkAudioIcon.png"
cp "$repo_root/BlackHole/PiTalkAudio.icns" "$source_dir/BlackHole/PiTalkAudio.icns"
cp "$repo_root/Scripts/build_pi_talk_drivers.sh" "$source_dir/Scripts/"
cp "$repo_root/Scripts/install_pi_talk_drivers.sh" "$source_dir/Scripts/"
cp "$repo_root/Scripts/uninstall_pi_talk_drivers.sh" "$source_dir/Scripts/"
cp "$repo_root/Scripts/build_pi_talk_icon.py" "$source_dir/Scripts/"
cp "$repo_root/.gitignore" "$source_dir/.gitignore"
cp "$repo_root/LICENSE" "$source_dir/LICENSE"
cp "$repo_root/README.md" "$source_dir/README.md"
cp "$repo_root/UPSTREAM_CHANGELOG.md" "$source_dir/UPSTREAM_CHANGELOG.md"
cp "$repo_root/VERSION" "$source_dir/VERSION"
cp "$repo_root/BUILD_NUMBER" "$source_dir/BUILD_NUMBER"
cp "$repo_root/PI_TALK_AUDIO.md" "$source_dir/PI_TALK_AUDIO.md"
cp "$repo_root/PI_TALK_DRIVER_NOTICE.md" "$source_dir/PI_TALK_DRIVER_NOTICE.md"
cp "$repo_root/UPSTREAM.md" "$source_dir/UPSTREAM.md"
chmod +x "$source_dir/Scripts/build_pi_talk_drivers.sh" \
    "$source_dir/Scripts/install_pi_talk_drivers.sh" \
    "$source_dir/Scripts/uninstall_pi_talk_drivers.sh" \
    "$source_dir/Scripts/build_pi_talk_icon.py"

distribution_zip="$output_dir.zip"
rm -f "$distribution_zip"
ditto -c -k --norsrc --noextattr --noqtn --keepParent "$output_dir" "$distribution_zip"

echo
echo "Built Apple Silicon driver in:"
echo "  $output_dir/PiTalk.driver"
echo
echo "Portable package:"
echo "  $distribution_zip"
echo
echo "Install locally with:"
echo "  $output_dir/install.sh"
