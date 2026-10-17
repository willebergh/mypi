import AppKit
import ApplicationServices
import Foundation

private let inspectedAttributes = [
    kAXRoleAttribute as String,
    kAXSubroleAttribute as String,
    kAXTitleAttribute as String,
    kAXDescriptionAttribute as String,
    kAXValueAttribute as String,
    "AXIdentifier",
    "AXMenuItemMarkChar",
    kAXHelpAttribute as String,
    kAXPlaceholderValueAttribute as String,
    kAXEnabledAttribute as String,
    kAXFocusedAttribute as String,
    kAXSelectedAttribute as String,
    kAXPositionAttribute as String,
    kAXSizeAttribute as String
]

private let observedNotifications = [
    kAXCreatedNotification as String,
    kAXUIElementDestroyedNotification as String,
    kAXFocusedUIElementChangedNotification as String,
    kAXFocusedWindowChangedNotification as String,
    kAXWindowCreatedNotification as String,
    kAXTitleChangedNotification as String,
    kAXValueChangedNotification as String,
    kAXSelectedChildrenChangedNotification as String,
    kAXSelectedRowsChangedNotification as String,
    kAXRowExpandedNotification as String,
    kAXRowCollapsedNotification as String,
    // AXMoved/AXResized are extremely noisy for Notification Centre call banners.
    // Periodic reconciliation still captures geometry when diagnostics are needed.
    kAXLayoutChangedNotification as String
]

func accessibilityTrusted(prompt: Bool) -> Bool {
    let options = ["AXTrustedCheckOptionPrompt": prompt] as CFDictionary
    return AXIsProcessTrustedWithOptions(options)
}

func permissionDiagnostic() -> [String: Any] {
    let trusted = AXIsProcessTrusted()
    return [
        "trusted": trusted,
        "instructions": trusted ? "Accessibility access is enabled." : "Enable your terminal (or installed facetime-observer binary) in System Settings > Privacy & Security > Accessibility, then restart it."
    ]
}

final class AXTreeReader {
    let maxDepth: Int
    let maxNodes: Int
    private(set) var count = 0

    init(maxDepth: Int, maxNodes: Int) {
        self.maxDepth = maxDepth
        self.maxNodes = maxNodes
    }

    func tree(for target: ProcessTarget, keywords: [String]) -> [String: Any] {
        count = 0
        let root = AXUIElementCreateApplication(target.pid)
        var visited = Set<CFHashCode>()
        var result: [String: Any] = ["process": target.json]
        if let node = read(root, depth: 0, visited: &visited) {
            result["tree"] = keywords.isEmpty ? node : (filtered(node, keywords: keywords) ?? ["matched": false])
        } else {
            result["error"] = "Unable to read accessibility root (process may be stale or inaccessible)"
        }
        result["nodeCount"] = count
        result["truncated"] = count >= maxNodes
        return result
    }

    func summary(_ element: AXUIElement) -> [String: Any] {
        var output: [String: Any] = [:]
        for attribute in inspectedAttributes {
            var value: CFTypeRef?
            let error = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
            if error == .success, let value { output[attribute] = axValueDescription(value) }
        }
        var pid: pid_t = 0
        if AXUIElementGetPid(element, &pid) == .success { output["pid"] = Int(pid) }
        return output
    }

    private func read(_ element: AXUIElement, depth: Int, visited: inout Set<CFHashCode>) -> [String: Any]? {
        guard count < maxNodes else { return nil }
        let identity = CFHash(element)
        guard !visited.contains(identity) else { return ["reference": identity] }
        visited.insert(identity)
        count += 1

        var node = summary(element)
        node["depth"] = depth

        var actionNames: CFArray?
        let actionError = AXUIElementCopyActionNames(element, &actionNames)
        if actionError == .success, let actions = actionNames as? [String], !actions.isEmpty {
            node["actions"] = actions
        }

        if depth < maxDepth {
            var rawChildren: CFTypeRef?
            let error = AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &rawChildren)
            if error == .success, let children = rawChildren as? [AXUIElement] {
                let output = children.compactMap { read($0, depth: depth + 1, visited: &visited) }
                if !output.isEmpty { node["children"] = output }
            } else if error != .noValue && error != .attributeUnsupported {
                node["childrenError"] = axErrorName(error)
            }
        } else {
            node["depthLimitReached"] = true
        }
        return node
    }

    private func filtered(_ node: [String: Any], keywords: [String]) -> [String: Any]? {
        let ownText = node.filter { $0.key != "children" }.map { "\($0.key)=\($0.value)" }.joined(separator: " ")
        let ownMatch = keywords.contains { ownText.localizedCaseInsensitiveContains($0) }
        let children = (node["children"] as? [[String: Any]] ?? []).compactMap { filtered($0, keywords: keywords) }
        if !ownMatch && children.isEmpty { return nil }
        var copy = node
        if children.isEmpty { copy.removeValue(forKey: "children") } else { copy["children"] = children }
        copy["matched"] = ownMatch
        return copy
    }
}

final class AXProcessObserver {
    let target: ProcessTarget
    private let reader: AXTreeReader
    private let emit: ([String: Any]) -> Void
    private var observer: AXObserver?
    private var registeredElements = Set<CFHashCode>()

    init(target: ProcessTarget, reader: AXTreeReader, emit: @escaping ([String: Any]) -> Void) {
        self.target = target
        self.reader = reader
        self.emit = emit
    }

    func start() -> String? {
        var created: AXObserver?
        let error = AXObserverCreate(target.pid, { _, element, notification, refcon in
            guard let refcon else { return }
            let owner = Unmanaged<AXProcessObserver>.fromOpaque(refcon).takeUnretainedValue()
            owner.received(element: element, notification: notification as String)
        }, &created)
        guard error == .success, let created else { return axErrorName(error) }
        observer = created
        CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(created), .commonModes)
        registerCurrentTree()
        return nil
    }

    func stop() {
        if let observer {
            CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .commonModes)
        }
        observer = nil
        registeredElements.removeAll()
    }

    func registerCurrentTree() {
        guard let observer else { return }
        let root = AXUIElementCreateApplication(target.pid)
        var queue: [(AXUIElement, Int)] = [(root, 0)]
        var examined = 0
        while !queue.isEmpty && examined < reader.maxNodes {
            let (element, depth) = queue.removeFirst()
            examined += 1
            let identity = CFHash(element)
            if registeredElements.insert(identity).inserted {
                for name in observedNotifications {
                    let result = AXObserverAddNotification(
                        observer,
                        element,
                        name as CFString,
                        Unmanaged.passUnretained(self).toOpaque()
                    )
                    if result != .success && result != .notificationUnsupported && result != .notificationAlreadyRegistered && result != .invalidUIElement && result != .illegalArgument && result != .cannotComplete {
                        emit(["type": "diagnostic", "level": "debug", "message": "AX notification registration failed", "notification": name, "error": axErrorName(result), "pid": Int(target.pid)])
                    }
                }
            }
            guard depth < reader.maxDepth else { continue }
            var raw: CFTypeRef?
            if AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &raw) == .success,
               let children = raw as? [AXUIElement] {
                queue.append(contentsOf: children.map { ($0, depth + 1) })
            }
        }
    }

    private func received(element: AXUIElement, notification: String) {
        guard observer != nil else { return }
        emit([
            "type": "event",
            "event": "accessibility.changed",
            "timestamp": timestamp(),
            "process": target.json,
            "notification": notification,
            "element": reader.summary(element)
        ])
        if notification == kAXCreatedNotification as String || notification == kAXWindowCreatedNotification as String || notification == kAXLayoutChangedNotification as String {
            registerCurrentTree()
        }
    }
}
