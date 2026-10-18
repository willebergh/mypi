import ApplicationServices
import CoreAudio
import Foundation

let piTalkVisibleAudioUID = "io.github.willebergh.pitalk.audio.visible"
let faceTimeSystemDefaultInputIdentifier = "system-default:\(piTalkVisibleAudioUID)"

struct FaceTimeAudioDevice: Equatable {
    let section: String
    let name: String
    let identifier: String?
    let selected: Bool
    let enabled: Bool

    var json: [String: Any] {
        [
            "section": section,
            "name": name,
            "identifier": identifier ?? NSNull(),
            "selected": selected,
            "enabled": enabled
        ]
    }
}

struct FaceTimeAudioRoutingResult {
    let ok: Bool
    let error: String?
    let devices: [FaceTimeAudioDevice]
}

func listFaceTimeAudioDevices(targets: [ProcessTarget]) -> FaceTimeAudioRoutingResult {
    guard let menu = faceTimeVideoMenu(targets: targets) else {
        return FaceTimeAudioRoutingResult(ok: false, error: "FaceTime's Video menu is unavailable; open FaceTime and retry", devices: [])
    }
    return FaceTimeAudioRoutingResult(ok: true, error: nil, devices: routedAudioDevices(in: menu))
}

func selectFaceTimeAudioDevices(input: String?, output: String?, targets: [ProcessTarget]) -> FaceTimeAudioRoutingResult {
    guard input != nil || output != nil else {
        return FaceTimeAudioRoutingResult(ok: false, error: "At least one of input or output is required", devices: [])
    }

    // Preflight both names before changing either selection.
    let available = listFaceTimeAudioDevices(targets: targets)
    guard available.ok else { return available }
    for (section, wanted) in [("input", input), ("output", output)] {
        guard let wanted else { continue }
        guard available.devices.filter({ $0.section == section && $0.enabled && $0.name.caseInsensitiveCompare(wanted) == .orderedSame }).count == 1 else {
            return FaceTimeAudioRoutingResult(ok: false, error: "No unique enabled FaceTime \(section) device exactly named '\(wanted)'", devices: available.devices)
        }
    }

    var selectedDevices: [FaceTimeAudioDevice] = []
    for request in [("input", input), ("output", output)] {
        guard let wanted = request.1 else { continue }
        guard let menu = faceTimeVideoMenu(targets: targets) else {
            return FaceTimeAudioRoutingResult(ok: false, error: "FaceTime's Video menu is unavailable; open FaceTime and retry", devices: selectedDevices)
        }
        let devices = routedAudioDevices(in: menu)
        let matches = devices.filter { $0.section == request.0 && $0.name.caseInsensitiveCompare(wanted) == .orderedSame }
        guard matches.count == 1 else {
            let message = matches.isEmpty
                ? "No FaceTime \(request.0) device exactly named '\(wanted)'"
                : "FaceTime \(request.0) device name '\(wanted)' is ambiguous"
            return FaceTimeAudioRoutingResult(ok: false, error: message, devices: devices)
        }
        let match = matches[0]
        if request.0 == "input", match.identifier == faceTimeSystemDefaultInputIdentifier,
           hasVerifiedSoleDefaultPiTalkInput(in: menu) {
            // FaceTime omits its entire Microphone section when Pi Talk is the
            // sole/default input. Core Audio's exact fixed UID is then the only
            // available selection authority; there is no AX item to pick.
            selectedDevices.append(match)
            continue
        }
        guard let element = menuItem(named: wanted, section: request.0, in: menu) else {
            return FaceTimeAudioRoutingResult(ok: false, error: "Device disappeared while selecting '\(wanted)'", devices: devices)
        }
        let actions = axActionNames(element)
        guard actions.contains(kAXPickAction as String) else {
            return FaceTimeAudioRoutingResult(ok: false, error: "Device '\(wanted)' does not expose safe AXPick selection", devices: devices)
        }
        // AXPick selects the hidden menu item without entering AppKit's modal
        // menu-tracking loop. Never fall back to AXPress here.
        let result = AXUIElementPerformAction(element, kAXPickAction as CFString)
        guard result == .success else {
            return FaceTimeAudioRoutingResult(ok: false, error: "Could not select '\(wanted)': \(axErrorName(result))", devices: devices)
        }
        selectedDevices.append(match)
    }

    let final = listFaceTimeAudioDevices(targets: targets)
    guard final.ok else { return final }
    let error = faceTimeAudioRoutingVerificationError(input: input, output: output, devices: final.devices)
    return FaceTimeAudioRoutingResult(ok: error == nil, error: error, devices: final.devices)
}

// Pure verification: AXPick success alone does not prove FaceTime changed its
// route. Both requested names must be uniquely present and marked selected.
func faceTimeAudioRoutingVerificationError(input: String?, output: String?, devices: [FaceTimeAudioDevice]) -> String? {
    for (section, wanted) in [("input", input), ("output", output)] {
        guard let wanted else { continue }
        let matches = devices.filter { $0.section == section && $0.enabled && $0.name.caseInsensitiveCompare(wanted) == .orderedSame }
        guard matches.count == 1, matches[0].selected else {
            return "Could not verify FaceTime \(section) device '\(wanted)' is selected"
        }
    }
    return nil
}

private func faceTimeVideoMenu(targets: [ProcessTarget]) -> AXUIElement? {
    guard let target = targets.first(where: { $0.bundleIdentifier == "com.apple.FaceTime" }) else { return nil }
    let root = AXUIElementCreateApplication(target.pid)
    guard let video = findAXElement(root: root, maxDepth: 5, maxNodes: 500, where: {
        axString($0, kAXRoleAttribute as String) == (kAXMenuBarItemRole as String) &&
        axString($0, kAXTitleAttribute as String) == "Video"
    }) else { return nil }

    // FaceTime exposes the Video menu's children while the menu is closed.
    // Never press the menu-bar item: doing so enters AppKit's modal menu-tracking
    // loop and can capture keyboard focus for the whole desktop.
    return findAXElement(root: video, maxDepth: 2, maxNodes: 100, where: {
        axString($0, kAXRoleAttribute as String) == (kAXMenuRole as String)
    })
}

private func routedAudioDevices(in menu: AXUIElement) -> [FaceTimeAudioDevice] {
    let children = axChildren(menu)
    let devices = audioDevices(in: children)
    return addingSoleDefaultPiTalkInput(
        to: devices,
        microphoneSectionPresent: hasAudioSection("Microphone", in: children),
        outputSectionPresent: hasAudioSection("Output", in: children),
        defaultInputUID: coreAudioDefaultInputUID()
    )
}

private func hasAudioSection(_ name: String, in items: [AXUIElement]) -> Bool {
    items.contains {
        axString($0, kAXRoleAttribute as String) == (kAXMenuItemRole as String) &&
        axString($0, kAXTitleAttribute as String) == name
    }
}

private func hasVerifiedSoleDefaultPiTalkInput(in menu: AXUIElement) -> Bool {
    let children = axChildren(menu)
    return !hasAudioSection("Microphone", in: children) &&
        hasAudioSection("Output", in: children) &&
        coreAudioDefaultInputUID() == piTalkVisibleAudioUID
}

// FaceTime 36 on macOS 26.6 omits the complete Microphone menu section when
// Pi Talk is the system's sole/default input. Accept that narrow case only when
// Core Audio independently resolves the current default to the driver's fixed
// visible UID. If a selector exists, its AX selection remains authoritative.
func addingSoleDefaultPiTalkInput(to devices: [FaceTimeAudioDevice], microphoneSectionPresent: Bool,
                                  outputSectionPresent: Bool, defaultInputUID: String?) -> [FaceTimeAudioDevice] {
    guard !microphoneSectionPresent, outputSectionPresent,
          !devices.contains(where: { $0.section == "input" }),
          defaultInputUID == piTalkVisibleAudioUID else { return devices }
    return devices + [FaceTimeAudioDevice(
        section: "input",
        name: "Pi Talk",
        identifier: faceTimeSystemDefaultInputIdentifier,
        selected: true,
        enabled: true
    )]
}

private func coreAudioDefaultInputUID() -> String? {
    var defaultAddress = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDefaultInputDevice,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var deviceID = AudioObjectID(kAudioObjectUnknown)
    var size = UInt32(MemoryLayout<AudioObjectID>.size)
    let deviceIDSize = UInt32(MemoryLayout<AudioObjectID>.size)
    guard AudioObjectGetPropertyData(
        AudioObjectID(kAudioObjectSystemObject), &defaultAddress, 0, nil, &size, &deviceID
    ) == noErr, size == deviceIDSize, deviceID != kAudioObjectUnknown else { return nil }

    var uidAddress = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyDeviceUID,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var uid: Unmanaged<CFString>?
    let uidSize = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    size = uidSize
    guard AudioObjectGetPropertyData(deviceID, &uidAddress, 0, nil, &size, &uid) == noErr,
          size == uidSize else { return nil }
    return uid?.takeUnretainedValue() as String?
}

private func audioDevices(in items: [AXUIElement]) -> [FaceTimeAudioDevice] {
    var section: String?
    var output: [FaceTimeAudioDevice] = []
    for item in items {
        guard axString(item, kAXRoleAttribute as String) == (kAXMenuItemRole as String) else { continue }
        let title = axString(item, kAXTitleAttribute as String) ?? ""
        if title == "Microphone" { section = "input"; continue }
        if title == "Output" { section = "output"; continue }
        guard let section, !title.isEmpty else { continue }
        let enabled = axBool(item, kAXEnabledAttribute as String) ?? false
        guard enabled else { continue }
        let mark = axString(item, "AXMenuItemMarkChar") ?? ""
        let selected = !mark.isEmpty || (axBool(item, kAXSelectedAttribute as String) ?? false)
        output.append(FaceTimeAudioDevice(
            section: section,
            name: title,
            identifier: axString(item, "AXIdentifier"),
            selected: selected,
            enabled: enabled
        ))
    }
    return output
}

private func menuItem(named name: String, section wantedSection: String, in menu: AXUIElement) -> AXUIElement? {
    var section: String?
    for item in axChildren(menu) {
        let title = axString(item, kAXTitleAttribute as String) ?? ""
        if title == "Microphone" { section = "input"; continue }
        if title == "Output" { section = "output"; continue }
        if section == wantedSection && title.caseInsensitiveCompare(name) == .orderedSame { return item }
    }
    return nil
}

private func findAXElement(root: AXUIElement, maxDepth: Int, maxNodes: Int, where predicate: (AXUIElement) -> Bool) -> AXUIElement? {
    var queue: [(AXUIElement, Int)] = [(root, 0)]
    var visited = Set<CFHashCode>()
    var count = 0
    while !queue.isEmpty && count < maxNodes {
        let (element, depth) = queue.removeFirst()
        count += 1
        guard visited.insert(CFHash(element)).inserted else { continue }
        if predicate(element) { return element }
        if depth < maxDepth { queue.append(contentsOf: axChildren(element).map { ($0, depth + 1) }) }
    }
    return nil
}

private func axChildren(_ element: AXUIElement) -> [AXUIElement] {
    var raw: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &raw) == .success else { return [] }
    return raw as? [AXUIElement] ?? []
}

private func axString(_ element: AXUIElement, _ attribute: String) -> String? {
    var raw: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute as CFString, &raw) == .success else { return nil }
    return raw as? String
}

private func axBool(_ element: AXUIElement, _ attribute: String) -> Bool? {
    var raw: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute as CFString, &raw) == .success else { return nil }
    return (raw as? NSNumber)?.boolValue
}

private func axActionNames(_ element: AXUIElement) -> [String] {
    var raw: CFArray?
    guard AXUIElementCopyActionNames(element, &raw) == .success else { return [] }
    return raw as? [String] ?? []
}
