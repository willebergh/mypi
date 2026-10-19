import ApplicationServices
import Foundation

struct AXActionResult {
    let ok: Bool
    let error: String?
    let element: [String: Any]?
}

// Pure matching seam for synthetic tests; End is never eligible outside a
// FaceTime banner. Deliberately no expectedCallId/identity targeting for End.
func semanticPressMatches(label: String, title: String?, description: String?, insideFaceTimeBanner: Bool) -> Bool {
    guard label.caseInsensitiveCompare("End") != .orderedSame || insideFaceTimeBanner else { return false }
    return [title, description].compactMap { $0 }.contains { $0.caseInsensitiveCompare(label) == .orderedSame }
}

func performSemanticPress(label: String, targets: [ProcessTarget], maxDepth: Int = 14, maxNodes: Int = 3_000) -> AXActionResult {
    for target in targets where target.bundleIdentifier == "com.apple.notificationcenterui" {
        let root = AXUIElementCreateApplication(target.pid)
        var queue: [(AXUIElement, Int, Bool)] = [(root, 0, false)]
        var visited = Set<CFHashCode>()
        var count = 0
        while !queue.isEmpty && count < maxNodes {
            let (element, depth, parentIsFaceTimeBanner) = queue.removeFirst()
            count += 1
            let hash = CFHash(element)
            guard visited.insert(hash).inserted else { continue }

            let title = copyStringAttribute(element, kAXTitleAttribute as String)
            let description = copyStringAttribute(element, kAXDescriptionAttribute as String)
            let insideFaceTimeBanner = parentIsFaceTimeBanner ||
                copyStringAttribute(element, "AXIdentifier") == "FACETIME_NOTIFICATION" ||
                description == "FACETIME_NOTIFICATION"
            if semanticPressMatches(label: label, title: title, description: description, insideFaceTimeBanner: insideFaceTimeBanner) {
                var actions: CFArray?
                let actionError = AXUIElementCopyActionNames(element, &actions)
                let names = actions as? [String] ?? []
                guard actionError == .success, names.contains(kAXPressAction as String) else {
                    return AXActionResult(ok: false, error: "Matching \(label) element does not support AXPress", element: ["process": target.json, "title": title ?? NSNull(), "description": description ?? NSNull(), "actions": names])
                }
                let result = AXUIElementPerformAction(element, kAXPressAction as CFString)
                return AXActionResult(
                    ok: result == .success,
                    error: result == .success ? nil : axErrorName(result),
                    element: ["process": target.json, "title": title ?? NSNull(), "description": description ?? NSNull(), "actions": names]
                )
            }

            guard depth < maxDepth else { continue }
            var raw: CFTypeRef?
            if AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &raw) == .success,
               let children = raw as? [AXUIElement] {
                queue.append(contentsOf: children.map { ($0, depth + 1, insideFaceTimeBanner) })
            }
        }
    }
    return AXActionResult(ok: false, error: "No visible \(label) control was found", element: nil)
}

func performIncomingAnswer(expectedIdentity: String, targets: [ProcessTarget]) -> AXActionResult {
    guard let match = verifiedFaceTimeBannerButton(
        label: "Answer",
        expectedIdentity: expectedIdentity,
        identitySuffix: ", FaceTime",
        targets: targets
    ) else {
        return AXActionResult(ok: false, error: "Verified incoming Answer button was not found", element: nil)
    }
    guard let position = axPoint(match.button, kAXPositionAttribute as String),
          let size = axSize(match.button, kAXSizeAttribute as String),
          size.width > 0, size.height > 0 else {
        return AXActionResult(ok: false, error: "Incoming Answer button has no usable screen bounds", element: nil)
    }

    let clickPoint = CGPoint(x: position.x + size.width / 2, y: position.y + size.height / 2)
    let originalPoint = CGEvent(source: nil)?.location
    guard let move = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: clickPoint, mouseButton: .left),
          let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: clickPoint, mouseButton: .left),
          let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: clickPoint, mouseButton: .left) else {
        return AXActionResult(ok: false, error: "Could not create mouse events for Answer", element: nil)
    }
    move.post(tap: .cghidEventTap)
    usleep(25_000)
    down.post(tap: .cghidEventTap)
    usleep(40_000)
    up.post(tap: .cghidEventTap)
    if let originalPoint,
       let restore = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: originalPoint, mouseButton: .left) {
        usleep(25_000)
        restore.post(tap: .cghidEventTap)
    }
    return AXActionResult(
        ok: true,
        error: nil,
        element: ["process": match.target.json, "description": "Answer", "identity": expectedIdentity, "method": "verified_dynamic_click"]
    )
}

func performCallConfirmation(expectedIdentity: String, expectedMedia: FaceTimeCallMedia = .audio, targets: [ProcessTarget]) -> AXActionResult {
    var matches: [VerifiedBannerButton] = []
    for target in targets where target.bundleIdentifier == "com.apple.notificationcenterui" {
        let root = AXUIElementCreateApplication(target.pid)
        let banners = findElements(root: root, maxDepth: 14, maxNodes: 3_000, where: {
            copyStringAttribute($0, "AXIdentifier") == "FACETIME_NOTIFICATION" ||
            copyStringAttribute($0, kAXDescriptionAttribute as String) == "FACETIME_NOTIFICATION"
        })
        for banner in banners {
            let nodes = findElements(root: banner, maxDepth: 8, maxNodes: 300, where: { _ in true })
            let strings = nodes.flatMap { node in
                [kAXTitleAttribute as String, kAXDescriptionAttribute as String, kAXValueAttribute as String].compactMap { copyStringAttribute(node, $0) }
            }
            guard let confirmation = CallConfirmation.fromBannerStrings(strings),
                  normalizedIdentity(confirmation.identity) == normalizedIdentity(expectedIdentity) else { continue }
            guard confirmation.permits(expectedMedia) else {
                return AXActionResult(ok: false, error: "FaceTime confirmation media is mismatched or ambiguous for requested \(expectedMedia.rawValue); not pressed", element: nil)
            }
            let buttons = nodes.filter { node in
                let role = copyStringAttribute(node, kAXRoleAttribute as String)
                let labels = [copyStringAttribute(node, kAXTitleAttribute as String), copyStringAttribute(node, kAXDescriptionAttribute as String)].compactMap { $0 }
                return (role == (kAXButtonRole as String) || role == (kAXPopUpButtonRole as String)) && labels.contains("Call")
            }
            guard buttons.count == 1 else {
                return AXActionResult(ok: false, error: "FaceTime confirmation Call control is missing or ambiguous; not pressed", element: nil)
            }
            matches.append(VerifiedBannerButton(target: target, button: buttons[0]))
        }
    }
    guard matches.count == 1, let match = matches.first else {
        return AXActionResult(ok: false, error: "Unique identity/media-verified FaceTime Call banner was not found", element: nil)
    }
    let result = AXUIElementPerformAction(match.button, kAXPressAction as CFString)
    return AXActionResult(ok: result == .success, error: result == .success ? nil : axErrorName(result),
        element: ["process": match.target.json, "description": "Call", "identity": expectedIdentity,
                  "requestedMedia": expectedMedia.rawValue, "method": "AXPress"])
}

// Video controls are selected from a fresh complete FaceTime tree, then
// reacquired by ephemeral AXChildren path. No coordinate or banner fallback.
func performVideoCallPress(expected: VideoCallControl, targets: [ProcessTarget],
                          select: ([[String: Any]]) -> VideoCallControl?) -> AXActionResult {
    let apps = targets.filter { $0.bundleIdentifier == "com.apple.FaceTime" }
    let reader = AXTreeReader(maxDepth: 16, maxNodes: 3_000)
    let snapshots = apps.map { reader.tree(for: $0, keywords: []) }
    guard select(snapshots) == expected, apps.count == 1, Int(apps[0].pid) == expected.pid else {
        return AXActionResult(ok: false, error: "Video call target changed or is ambiguous; not pressed, do not retry automatically", element: nil)
    }
    var element = AXUIElementCreateApplication(apps[0].pid)
    for index in expected.path {
        var raw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &raw) == .success,
              let children = raw as? [AXUIElement], children.indices.contains(index) else {
            return AXActionResult(ok: false, error: "Video call control disappeared; not pressed", element: nil)
        }
        element = children[index]
    }
    var enabled: CFTypeRef?, actions: CFArray?
    guard copyStringAttribute(element, kAXRoleAttribute as String) == "AXButton",
          copyStringAttribute(element, kAXDescriptionAttribute as String) == expected.label,
          AXUIElementCopyAttributeValue(element, kAXEnabledAttribute as CFString, &enabled) == .success,
          (enabled as? NSNumber)?.boolValue == true,
          AXUIElementCopyActionNames(element, &actions) == .success,
          (actions as? [String] ?? []).contains("AXPress") else {
        return AXActionResult(ok: false, error: "Video call control is no longer uniquely actionable; not pressed", element: nil)
    }
    let result = AXUIElementPerformAction(element, kAXPressAction as CFString)
    return AXActionResult(ok: result == .success, error: result == .success ? nil : axErrorName(result),
                          element: ["description": expected.label, "method": "AXPress", "identity": expected.identity])
}

private struct VerifiedBannerButton {
    let target: ProcessTarget
    let button: AXUIElement
}

private func verifiedFaceTimeBannerButton(label: String, expectedIdentity: String, identitySuffix: String, targets: [ProcessTarget]) -> VerifiedBannerButton? {
    for target in targets where target.bundleIdentifier == "com.apple.notificationcenterui" {
        let root = AXUIElementCreateApplication(target.pid)
        let banners = findElements(root: root, maxDepth: 14, maxNodes: 3_000, where: {
            copyStringAttribute($0, "AXIdentifier") == "FACETIME_NOTIFICATION" ||
            copyStringAttribute($0, kAXDescriptionAttribute as String) == "FACETIME_NOTIFICATION"
        })
        for banner in banners {
            let identityMatches = findElement(root: banner, maxDepth: 8, maxNodes: 300, where: {
                guard let description = copyStringAttribute($0, kAXDescriptionAttribute as String),
                      description.localizedCaseInsensitiveContains(identitySuffix) else { return false }
                let identity = description.components(separatedBy: identitySuffix).first ?? ""
                return normalizedIdentity(identity) == normalizedIdentity(expectedIdentity)
            }) != nil
            guard identityMatches else { continue }
            if let button = findElement(root: banner, maxDepth: 8, maxNodes: 300, where: {
                let role = copyStringAttribute($0, kAXRoleAttribute as String)
                let description = copyStringAttribute($0, kAXDescriptionAttribute as String)
                let title = copyStringAttribute($0, kAXTitleAttribute as String)
                return (role == (kAXButtonRole as String) || role == (kAXPopUpButtonRole as String)) &&
                    [description, title].compactMap { $0 }.contains(label)
            }) {
                return VerifiedBannerButton(target: target, button: button)
            }
        }
    }
    return nil
}

private func findElement(root: AXUIElement, maxDepth: Int, maxNodes: Int, where predicate: (AXUIElement) -> Bool) -> AXUIElement? {
    findElements(root: root, maxDepth: maxDepth, maxNodes: maxNodes, where: predicate).first
}

private func findElements(root: AXUIElement, maxDepth: Int, maxNodes: Int, where predicate: (AXUIElement) -> Bool) -> [AXUIElement] {
    var matches: [AXUIElement] = []
    var queue: [(AXUIElement, Int)] = [(root, 0)]
    var visited = Set<CFHashCode>()
    var count = 0
    while !queue.isEmpty && count < maxNodes {
        let (element, depth) = queue.removeFirst()
        count += 1
        guard visited.insert(CFHash(element)).inserted else { continue }
        if predicate(element) { matches.append(element) }
        guard depth < maxDepth else { continue }
        var raw: CFTypeRef?
        if AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &raw) == .success,
           let children = raw as? [AXUIElement] {
            queue.append(contentsOf: children.map { ($0, depth + 1) })
        }
    }
    return matches
}

private func axPoint(_ element: AXUIElement, _ attribute: String) -> CGPoint? {
    var raw: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute as CFString, &raw) == .success,
          let value = raw, CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
    var point = CGPoint.zero
    return AXValueGetValue(unsafeBitCast(value, to: AXValue.self), .cgPoint, &point) ? point : nil
}

private func axSize(_ element: AXUIElement, _ attribute: String) -> CGSize? {
    var raw: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute as CFString, &raw) == .success,
          let value = raw, CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
    var size = CGSize.zero
    return AXValueGetValue(unsafeBitCast(value, to: AXValue.self), .cgSize, &size) ? size : nil
}

private func copyStringAttribute(_ element: AXUIElement, _ attribute: String) -> String? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else { return nil }
    return value as? String
}
