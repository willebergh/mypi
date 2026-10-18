import XCTest
@testable import FaceTimeObserver

private func videoFixture(width: Double = 150, height: Double = 100, peer: String = "Test Peer", rotate: Bool = true, pid: Int = 42) -> [String: Any] {
    func size(_ width: Double, _ height: Double) -> [String: Double] { ["width": width, "height": height] }
    var children: [[String: Any]] = [
        ["AXRole": "AXGenericElement", "AXIdentifier": "ParticipantGridView"],
        ["AXRole": "AXButton", "AXDescription": peer, "AXSize": size(427, 640), "actions": ["Name:Enter Fullscreen\nTarget:0x0\nSelector:(null)"]],
        ["AXRole": "AXButton", "AXIdentifier": "LocalParticipantView", "AXSize": size(width, height), "AXPosition": ["x": 100.0, "y": 200.0]]
    ]
    if rotate { children.append(["AXRole": "AXButton", "AXIdentifier": "Rotate Camera", "AXDescription": "Rotate Camera", "AXEnabled": true, "actions": ["AXPress"]]) }
    return ["process": ["pid": pid, "bundleIdentifier": "com.apple.FaceTime"], "tree": ["AXRole": "AXApplication", "children": [
        ["AXRole": "AXWindow", "AXIdentifier": "SceneWindow", "AXSize": size(427, 640), "children": children]
    ]]]
}

private final class VideoAXStub: VideoLayoutAX {
    var current = VideoLayout.extract([videoFixture()])!
    var presses = 0
    var hovers = 0
    var restores = 0
    var changeOnPress = true
    var revealOnHover = true
    var onRead: (() -> Void)?
    func read() throws -> VideoLayout { onRead?(); return current }
    func hover(_ layout: VideoLayout) throws {
        hovers += 1
        if revealOnHover { current = VideoLayout.extract([videoFixture()])! }
    }
    func restorePointer() { restores += 1 }
    func pressRotate(_ layout: VideoLayout) throws {
        presses += 1
        if changeOnPress { current = VideoLayout.extract([videoFixture(width: 84, height: 150)])! }
    }
}

final class VideoLayoutTests: XCTestCase {
    func testAcceptsNativeAXCGFloatGeometryWithoutJSONRoundTrip() throws {
        let rect = try XCTUnwrap(VideoRect([
            "AXPosition": ["x": CGFloat(123), "y": CGFloat(456)],
            "AXSize": ["width": CGFloat(150), "height": CGFloat(69)]
        ]))
        XCTAssertEqual(rect.x, 123)
        XCTAssertEqual(rect.y, 456)
        XCTAssertEqual(rect.width, 150)
        XCTAssertEqual(rect.height, 69)
    }
    func testExtractsObservedPreviewNotRemotePhoneOrientation() throws {
        let layout = try XCTUnwrap(VideoLayout.extract([videoFixture(height: 69)]))
        XCTAssertEqual(layout.windowID, "42:SceneWindow")
        XCTAssertEqual(layout.peer, "Test Peer")
        XCTAssertEqual(layout.localPreview.aspectRatio, 150.0 / 69)
        XCTAssertEqual(layout.json["source"] as? String, "local_preview_geometry")
        XCTAssertEqual(layout.json["remoteOrientation"] as? String, "unknown")
        XCTAssertTrue(layout.rotationAvailable)
    }
    func testRejectsMissingDuplicateOrTruncatedVideoContext() throws {
        let fixture = videoFixture()
        XCTAssertNil(VideoLayout.extract([]))
        XCTAssertNil(VideoLayout.extract([fixture, fixture]))
        var truncated = fixture; truncated["truncated"] = true
        XCTAssertNil(VideoLayout.extract([truncated]))
        var tree = fixture["tree"] as! [String: Any]
        let window = (tree["children"] as! [[String: Any]])[0]
        tree["children"] = [window, window]
        var ambiguous = fixture; ambiguous["tree"] = tree
        XCTAssertNil(VideoLayout.extract([ambiguous]))
        XCTAssertNil(VideoLayout.extract([videoFixture(width: 0)]))
        XCTAssertNil(VideoLayout.extract([videoFixture(peer: " ")]))
    }
    func testObserverReportsAspectChangesWithoutInferringTheirCause() throws {
        var observer = VideoLayoutObserver()
        let portrait = VideoLayout.extract([videoFixture()])!
        let landscape = VideoLayout.extract([videoFixture(height: 69)])!
        XCTAssertNil(observer.update(portrait))
        XCTAssertNil(observer.update(portrait))
        let event = try XCTUnwrap(observer.update(landscape))
        XCTAssertEqual(event["event"] as? String, "video.layout_changed")
        XCTAssertEqual(event["remoteOrientation"] as? String, "unknown")
        // Uniform resize is not an aspect-ratio event.
        XCTAssertNil(observer.update(VideoLayout.extract([videoFixture(width: 300, height: 138)])))
        XCTAssertNil(observer.update(nil))
        XCTAssertNil(observer.update(portrait))
        XCTAssertNil(observer.update(VideoLayout.extract([videoFixture(peer: "Other Peer")])))
        XCTAssertNil(observer.update(VideoLayout.extract([videoFixture(pid: 43)])))
    }
    func testRotatePressesOnceAndVerifiesGeometryChange() throws {
        let ax = VideoAXStub()
        var queue: [() -> Void] = []
        let controller = VideoLayoutController(ax: ax, isRunning: { true }, schedule: { _, work in queue.append(work) })
        var result: [String: Any]?
        controller.rotate(["expectedWindowId": "42:SceneWindow", "expectedPeer": "Test Peer"]) { outcome in
            if case .success(let value) = outcome { result = value }
        }
        while !queue.isEmpty { queue.removeFirst()() }
        XCTAssertEqual(ax.presses, 1)
        XCTAssertEqual(result?["verifiedChange"] as? Bool, true)
        XCTAssertEqual(ax.hovers, 0)
    }
    func testRevealsHiddenButtonOnceWithoutCoordinateClickFallback() throws {
        let ax = VideoAXStub(); ax.current = VideoLayout.extract([videoFixture(rotate: false)])!
        var queue: [() -> Void] = []
        let controller = VideoLayoutController(ax: ax, isRunning: { true }, schedule: { _, work in queue.append(work) })
        controller.rotate(["expectedWindowId": "42:SceneWindow", "expectedPeer": "Test Peer"]) { _ in }
        while !queue.isEmpty { queue.removeFirst()() }
        XCTAssertEqual(ax.hovers, 1)
        XCTAssertEqual(ax.presses, 1)
        XCTAssertEqual(ax.restores, 1)
    }
    func testMissingButtonFailsWithoutRepeatedHoversOrAnyPress() throws {
        let ax = VideoAXStub(); ax.current = VideoLayout.extract([videoFixture(rotate: false)])!; ax.revealOnHover = false
        var queue: [() -> Void] = []
        let controller = VideoLayoutController(ax: ax, isRunning: { true }, schedule: { _, work in queue.append(work) })
        var failure: VideoLayoutError?
        controller.rotate(["expectedWindowId": "42:SceneWindow", "expectedPeer": "Test Peer"]) { if case .failure(let e) = $0 { failure = e } }
        var count = 0
        while !queue.isEmpty && count < 30 { count += 1; queue.removeFirst()() }
        XCTAssertTrue(queue.isEmpty)
        XCTAssertEqual(failure?.code, "video_rotate_unavailable")
        XCTAssertEqual(ax.hovers, 1)
        XCTAssertEqual(ax.presses, 0)
    }
    func testActionAcceptanceDoesNotFabricateVerifiedChange() throws {
        let ax = VideoAXStub(); ax.changeOnPress = false
        var queue: [() -> Void] = []
        let controller = VideoLayoutController(ax: ax, isRunning: { true }, schedule: { _, work in queue.append(work) })
        var result: [String: Any]?
        controller.rotate(["expectedWindowId": "42:SceneWindow", "expectedPeer": "Test Peer"]) { if case .success(let x) = $0 { result = x } }
        while !queue.isEmpty { queue.removeFirst()() }
        XCTAssertEqual(ax.presses, 1)
        XCTAssertEqual(result?["attempted"] as? Bool, true)
        XCTAssertEqual(result?["verifiedChange"] as? Bool, false)
    }
    func testChangedPeerBeforeDelayedActionFailsWithoutPress() throws {
        let ax = VideoAXStub()
        var queue: [() -> Void] = []
        let controller = VideoLayoutController(ax: ax, isRunning: { true }, schedule: { _, work in queue.append(work) })
        var failure: VideoLayoutError?
        controller.rotate(["expectedWindowId": "42:SceneWindow", "expectedPeer": "Test Peer"]) { if case .failure(let e) = $0 { failure = e } }
        ax.current = VideoLayout.extract([videoFixture(peer: "Other Peer")])!
        while !queue.isEmpty { queue.removeFirst()() }
        XCTAssertEqual(failure?.code, "stale_video_view")
        XCTAssertEqual(ax.presses, 0)
    }
    func testInvalidationCancelsScheduledMutation() throws {
        let ax = VideoAXStub()
        var queue: [() -> Void] = []
        let controller = VideoLayoutController(ax: ax, isRunning: { true }, schedule: { _, work in queue.append(work) })
        controller.rotate(["expectedWindowId": "42:SceneWindow", "expectedPeer": "Test Peer"]) { _ in XCTFail("Stopped operation must not reply") }
        controller.invalidate()
        while !queue.isEmpty { queue.removeFirst()() }
        XCTAssertEqual(ax.presses, 0)
    }
    func testInvalidationDuringReadCannotPressOrHover() throws {
        let ax = VideoAXStub()
        var running = true
        var queue: [() -> Void] = []
        let controller = VideoLayoutController(ax: ax, isRunning: { running }, schedule: { _, work in queue.append(work) })
        controller.rotate(["expectedWindowId": "42:SceneWindow", "expectedPeer": "Test Peer"]) { _ in XCTFail("Stopped operation must not reply") }
        ax.onRead = { running = false }
        while !queue.isEmpty { queue.removeFirst()() }
        XCTAssertEqual(ax.presses, 0)
        XCTAssertEqual(ax.hovers, 0)
    }
    func testBusyRequestsCannotQueueAnotherRotation() throws {
        let ax = VideoAXStub()
        var queue: [() -> Void] = []
        let controller = VideoLayoutController(ax: ax, isRunning: { true }, schedule: { _, work in queue.append(work) })
        let command: [String: Any] = ["expectedWindowId": "42:SceneWindow", "expectedPeer": "Test Peer"]
        controller.rotate(command) { _ in }
        var error: VideoLayoutError?
        controller.rotate(command) { if case .failure(let e) = $0 { error = e } }
        XCTAssertEqual(error?.code, "video_busy")
        while !queue.isEmpty { queue.removeFirst()() }
        XCTAssertEqual(ax.presses, 1)
    }
    func testReadOnlyStatusDoesNotRevealOrPressControls() throws {
        let ax = VideoAXStub(); ax.current = VideoLayout.extract([videoFixture(rotate: false)])!
        let controller = VideoLayoutController(ax: ax, isRunning: { true })
        XCTAssertEqual(controller.status()["rotationAvailable"] as? Bool, false)
        XCTAssertEqual(ax.hovers, 0)
        XCTAssertEqual(ax.presses, 0)
    }

    func testMissingGuardsAndUnknownArgumentsAreRejected() throws {
        let ax = VideoAXStub()
        let controller = VideoLayoutController(ax: ax, isRunning: { true })
        for command in [[:], ["expectedWindowId": "42:SceneWindow"],
                        ["expectedWindowId": "42:SceneWindow", "expectedPeer": "Test Peer", "cameraOn": true]] as [[String: Any]] {
            var failure: VideoLayoutError?
            controller.rotate(command) { if case .failure(let e) = $0 { failure = e } }
            XCTAssertEqual(failure?.code, "invalid_command")
        }
        XCTAssertEqual(ax.presses, 0)
        XCTAssertEqual(ax.hovers, 0)
    }
}
