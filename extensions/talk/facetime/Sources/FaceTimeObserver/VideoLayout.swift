import ApplicationServices
import Foundation

struct VideoLayoutError: LocalizedError {
    let code: String
    let message: String
    var errorDescription: String? { message }
}

struct VideoRect: Equatable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
    let positionAvailable: Bool
    var aspectRatio: Double { width / height }
    var json: [String: Any] { ["width": width, "height": height, "aspectRatio": aspectRatio] }

    init?(_ node: [String: Any]) {
        guard let size = node["AXSize"] as? [String: Any],
              let width = (size["width"] as? NSNumber)?.doubleValue,
              let height = (size["height"] as? NSNumber)?.doubleValue,
              width.isFinite, height.isFinite, width > 0, height > 0 else { return nil }
        let position = node["AXPosition"] as? [String: Any] ?? [:]
        let x = (position["x"] as? NSNumber)?.doubleValue
        let y = (position["y"] as? NSNumber)?.doubleValue
        self.positionAvailable = x?.isFinite == true && y?.isFinite == true
        self.x = x ?? 0; self.y = y ?? 0
        self.width = width; self.height = height
    }
}

struct VideoLayout {
    let pid: pid_t
    let windowID: String
    let peer: String
    let window: VideoRect
    let localPreview: VideoRect
    let remoteView: VideoRect
    let rotationAvailable: Bool

    var json: [String: Any] {
        ["available": true, "pid": Int(pid), "windowId": windowID, "peer": peer,
         "window": window.json, "localPreview": localPreview.json, "remoteView": remoteView.json,
         "rotationAvailable": rotationAvailable, "source": "local_preview_geometry", "remoteOrientation": "unknown"]
    }
    func matches(windowID: String, peer: String) -> Bool {
        self.windowID == windowID && normalizedIdentity(self.peer) == normalizedIdentity(peer)
    }
    func aspectChanged(from previous: VideoLayout) -> Bool {
        abs(localPreview.aspectRatio / previous.localPreview.aspectRatio - 1) > 0.02
    }

    static func nodes(_ node: [String: Any]) -> [[String: Any]] {
        [node] + (node["children"] as? [[String: Any]] ?? []).flatMap(nodes)
    }
    static func extract(_ snapshots: [[String: Any]]) -> VideoLayout? {
        let apps = snapshots.filter { ($0["process"] as? [String: Any])?["bundleIdentifier"] as? String == "com.apple.FaceTime" }
        guard apps.count == 1, let app = apps.first,
              app["truncated"] as? Bool != true,
              let process = app["process"] as? [String: Any], let pid = process["pid"] as? Int,
              let tree = app["tree"] as? [String: Any] else { return nil }
        let all = nodes(tree)
        guard !all.contains(where: { $0["childrenError"] != nil || $0["depthLimitReached"] as? Bool == true }) else { return nil }
        let windows = all.filter { node in
            node["AXRole"] as? String == "AXWindow" && nodes(node).contains { $0["AXIdentifier"] as? String == "ParticipantGridView" }
        }
        guard windows.count == 1, let win = windows.first,
              let identifier = win["AXIdentifier"] as? String, !identifier.isEmpty,
              let windowRect = VideoRect(win) else { return nil }
        let contents = nodes(win)
        let local = contents.filter { $0["AXIdentifier"] as? String == "LocalParticipantView" }
        let grids = contents.filter { $0["AXIdentifier"] as? String == "ParticipantGridView" }
        let remote = contents.filter { node in
            node["AXRole"] as? String == "AXButton" && node["AXIdentifier"] as? String != "LocalParticipantView" &&
            (node["actions"] as? [String] ?? []).contains { $0.hasPrefix("Name:Enter Fullscreen\n") }
        }
        guard local.count == 1, grids.count == 1, remote.count == 1,
              let localRect = VideoRect(local[0]), let remoteRect = VideoRect(remote[0]),
              let peer = remote[0]["AXDescription"] as? String, !normalizedIdentity(peer).isEmpty else { return nil }
        let rotate = contents.filter {
            $0["AXRole"] as? String == "AXButton" && $0["AXIdentifier"] as? String == "Rotate Camera" &&
            $0["AXDescription"] as? String == "Rotate Camera" && $0["AXEnabled"] as? Bool == true &&
            ($0["actions"] as? [String] ?? []).contains("AXPress")
        }
        guard rotate.count <= 1 else { return nil }
        return VideoLayout(pid: pid_t(pid), windowID: "\(pid):\(identifier)", peer: peer, window: windowRect,
                           localPreview: localRect, remoteView: remoteRect, rotationAvailable: rotate.count == 1)
    }
}

struct VideoLayoutObserver {
    private var previous: VideoLayout?
    mutating func update(_ current: VideoLayout?) -> [String: Any]? {
        defer { previous = current }
        guard let current, let previous,
              current.matches(windowID: previous.windowID, peer: previous.peer), current.aspectChanged(from: previous) else { return nil }
        return ["type": "event", "event": "video.layout_changed", "windowId": current.windowID,
                "peer": current.peer, "source": "local_preview_geometry", "remoteOrientation": "unknown",
                "before": previous.localPreview.json, "after": current.localPreview.json]
    }
}

protocol VideoLayoutAX: AnyObject {
    func read() throws -> VideoLayout
    func hover(_ layout: VideoLayout) throws
    func restorePointer()
    func pressRotate(_ layout: VideoLayout) throws
}

final class NativeVideoLayoutAX: VideoLayoutAX {
    private var originalPointer: CGPoint?
    func read() throws -> VideoLayout {
        let apps = runningTargets(filter: TargetFilter()).filter { $0.bundleIdentifier == "com.apple.FaceTime" }
        guard apps.count == 1 else { throw unavailable() }
        let reader = AXTreeReader(maxDepth: 16, maxNodes: 3_000)
        let snapshots = apps.map { reader.tree(for: $0, keywords: []) }
        guard let layout = VideoLayout.extract(snapshots) else { throw unavailable() }
        return layout
    }
    private func unavailable() -> VideoLayoutError {
        VideoLayoutError(code: "video_view_unavailable", message: "A unique readable FaceTime video window with local and remote participant views is required")
    }
    func hover(_ layout: VideoLayout) throws {
        let fresh = try read()
        guard fresh.matches(windowID: layout.windowID, peer: layout.peer), fresh.localPreview.positionAvailable,
              fresh.localPreview.x.isFinite, fresh.localPreview.y.isFinite,
              let pointer = CGEvent(source: nil)?.location else { throw unavailable() }
        originalPointer = pointer
        let point = CGPoint(x: fresh.localPreview.x + fresh.localPreview.width / 2,
                            y: fresh.localPreview.y + fresh.localPreview.height / 2)
        guard let event = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left) else {
            throw VideoLayoutError(code: "video_hover_failed", message: "Could not reveal preview controls")
        }
        event.post(tap: .cghidEventTap)
    }
    func restorePointer() {
        guard let point = originalPointer else { return }
        originalPointer = nil
        CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
    }
    func pressRotate(_ layout: VideoLayout) throws {
        let fresh = try read()
        guard fresh.matches(windowID: layout.windowID, peer: layout.peer), fresh.rotationAvailable else { throw unavailable() }
        let app = AXUIElementCreateApplication(fresh.pid)
        var raw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &raw) == .success,
              let windows = raw as? [AXUIElement] else { throw unavailable() }
        func string(_ element: AXUIElement, _ name: String) -> String? {
            var value: CFTypeRef?
            guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
            return value as? String
        }
        let eligible = windows.filter { string($0, "AXIdentifier").map { "\(fresh.pid):\($0)" } == fresh.windowID }
        guard eligible.count == 1 else { throw unavailable() }
        var queue: [(AXUIElement, Int)] = [(eligible[0], 0)]
        var seen = Set<CFHashCode>(), matches: [AXUIElement] = [], count = 0
        while !queue.isEmpty {
            let (node, depth) = queue.removeFirst()
            guard depth <= 16, count < 3_000 else { throw unavailable() }
            guard seen.insert(CFHash(node)).inserted else { continue }
            count += 1
            if string(node, "AXRole") == "AXButton", string(node, "AXIdentifier") == "Rotate Camera",
               string(node, "AXDescription") == "Rotate Camera" { matches.append(node) }
            var children: CFTypeRef?
            let result = AXUIElementCopyAttributeValue(node, kAXChildrenAttribute as CFString, &children)
            guard result == .success || result == .noValue || result == .attributeUnsupported else { throw unavailable() }
            queue += (children as? [AXUIElement] ?? []).map { ($0, depth + 1) }
        }
        guard matches.count == 1, let button = matches.first else { throw unavailable() }
        var enabled: CFTypeRef?, actions: CFArray?
        guard AXUIElementCopyAttributeValue(button, kAXEnabledAttribute as CFString, &enabled) == .success,
              (enabled as? NSNumber)?.boolValue == true,
              AXUIElementCopyActionNames(button, &actions) == .success,
              (actions as? [String] ?? []).contains("AXPress") else { throw unavailable() }
        guard AXUIElementPerformAction(button, kAXPressAction as CFString) == .success else {
            throw VideoLayoutError(code: "video_rotate_failed", message: "Rotate Camera AXPress failed; outcome unknown, not retried")
        }
    }
}

final class VideoLayoutController {
    typealias Completion = (Result<[String: Any], VideoLayoutError>) -> Void
    private let ax: VideoLayoutAX
    private let isRunning: () -> Bool
    private let schedule: (TimeInterval, @escaping () -> Void) -> Void
    private var busy = false
    private var invalidated = false
    init(ax: VideoLayoutAX = NativeVideoLayoutAX(), isRunning: @escaping () -> Bool,
         schedule: @escaping (TimeInterval, @escaping () -> Void) -> Void = { delay, work in
             DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
         }) { self.ax = ax; self.isRunning = isRunning; self.schedule = schedule }
    func invalidate() { invalidated = true; busy = false; ax.restorePointer() }
    func status() -> [String: Any] {
        guard !invalidated, isRunning(), let layout = try? ax.read() else { return ["available": false] }
        return layout.json
    }
    func rotate(_ command: [String: Any], completion: @escaping Completion) {
        do {
            guard Set(command.keys).isSubset(of: ["type", "command", "id", "expectedWindowId", "expectedPeer"]),
                  let windowID = command["expectedWindowId"] as? String,
                  let peer = command["expectedPeer"] as? String,
                  [windowID, peer].allSatisfy({ !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && $0.utf8.count <= 512 &&
                      !$0.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) }) else {
                throw VideoLayoutError(code: "invalid_command", message: "video.rotate requires expectedWindowId and expectedPeer from video.status")
            }
            guard !invalidated, isRunning(), !busy else {
                throw VideoLayoutError(code: "video_busy", message: "Video controller is stopped or another rotate action is in progress")
            }
            let before = try ax.read()
            guard before.matches(windowID: windowID, peer: peer) else { throw stale() }
            busy = true
            var hovered = false, attempted = false, polls = 0
            func finish(_ result: Result<[String: Any], VideoLayoutError>) {
                self.ax.restorePointer(); self.busy = false
                guard !self.invalidated, self.isRunning() else { return }
                completion(result)
            }
            func tick() {
                guard !self.invalidated, self.isRunning() else { self.ax.restorePointer(); self.busy = false; return }
                do {
                    let current = try self.ax.read()
                    guard !self.invalidated, self.isRunning() else {
                        self.ax.restorePointer(); self.busy = false; return
                    }
                    guard current.matches(windowID: windowID, peer: peer) else { throw self.stale() }
                    if attempted {
                        let changed = current.aspectChanged(from: before)
                        if changed || polls >= 12 {
                            finish(.success(["attempted": true, "verifiedChange": changed, "before": before.json, "after": current.json]))
                            return
                        }
                    } else if current.rotationAvailable {
                        // Set first: an AX error may still have performed the action.
                        attempted = true
                        try self.ax.pressRotate(current)
                    } else if !hovered {
                        hovered = true
                        try self.ax.hover(current)
                    } else if polls >= 12 {
                        throw VideoLayoutError(code: "video_rotate_unavailable", message: "Rotate Camera did not appear after revealing the local preview; no click attempted")
                    }
                    polls += 1
                    self.schedule(0.15, tick)
                } catch {
                    finish(.failure((error as? VideoLayoutError) ?? VideoLayoutError(code: "video_rotate_failed", message: "Video action failed; outcome unknown, not retried")))
                }
            }
            schedule(0, tick)
        } catch {
            completion(.failure((error as? VideoLayoutError) ?? VideoLayoutError(code: "video_rotate_failed", message: "Video action failed")))
        }
    }
    private func stale() -> VideoLayoutError {
        VideoLayoutError(code: "stale_video_view", message: "FaceTime video window or participant changed; no further action, do not retry automatically")
    }
}
