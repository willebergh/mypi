import XCTest
@testable import FaceTimeObserver

private func followLayout(_ ratio: Double, peer: String = "Test Peer", id: String = "42:SceneWindow") -> VideoLayout {
    let local = VideoRect(["AXSize": ["width": ratio * 100, "height": 100.0]])!
    let window = VideoRect(["AXSize": ["width": 427.0, "height": 640.0]])!
    return VideoLayout(pid: 42, windowID: id, peer: peer, window: window, localPreview: local, remoteView: window, rotationAvailable: true)
}

private final class FollowHarness {
    var time: TimeInterval = 0
    var isAllowed = true
    var actions: [VideoFollowAction] = []
    var callbacks: [(Result<[String: Any], VideoLayoutError>) -> Void] = []
    var events: [[String: Any]] = []
    var saved: [VideoFollowSettings] = []
    var initial = VideoFollowSettings(enabled: true, calibrations: ["test peer": VideoFollowCalibration(portrait: 1.5, landscape: 2.17, portraitLocalAxis: "landscape", landscapeLocalAxis: "landscape")])
    lazy var follow = VideoFollowController(settings: initial, save: { self.saved.append($0) }, allowed: { _ in self.isAllowed },
        rotate: { action, complete in self.actions.append(action); self.callbacks.append(complete) },
        emit: { self.events.append($0) }, now: { self.time })
    func stable(_ ratio: Double) {
        follow.observe(followLayout(ratio)); time += 1.1; follow.observe(followLayout(ratio))
    }
    func finish(_ ratio: Double, changed: Bool = true) {
        callbacks.removeFirst()(.success(["verifiedChange": changed, "after": followLayout(ratio).json]))
    }
}

final class VideoFollowTests: XCTestCase {
    func testCalibrationUsesRelativeAxisAgreementNotAbsolutePhoneShape() throws {
        let calibration = VideoFollowCalibration(portrait: 1.5, landscape: 2.17, portraitLocalAxis: "landscape", landscapeLocalAxis: "landscape")
        XCTAssertTrue(calibration.complete)
        XCTAssertEqual(calibration.target(for: 1.5), "portrait")
        XCTAssertEqual(calibration.target(for: 1 / 1.5), "landscape")
        XCTAssertEqual(calibration.target(for: 2.17), "landscape")
        XCTAssertEqual(calibration.target(for: 1 / 2.17), "portrait")
        for unknown in [1.0, 1.8, 3.0, 0, -1, Double.nan, Double.infinity] { XCTAssertNil(calibration.target(for: unknown)) }
        XCTAssertFalse(VideoFollowCalibration(portrait: 1.5, landscape: 1.6).complete)
    }
    func testDebouncePreventsRotatingOnSingleOrTransientSamples() throws {
        let h = FollowHarness()
        h.follow.observe(followLayout(1.5)); h.follow.observe(followLayout(1.5))
        XCTAssertTrue(h.actions.isEmpty)
        h.time = 1.2; h.follow.observe(followLayout(1.5))
        XCTAssertEqual(h.actions.count, 1)
        XCTAssertEqual(h.actions[0].target, "portrait")
        XCTAssertEqual(h.actions[0].command["expectedWindowId"] as? String, "42:SceneWindow")
    }
    func testSuccessfulOwnRotationCannotTriggerFeedbackLoop() throws {
        let h = FollowHarness(); h.stable(1.5)
        XCTAssertEqual(h.actions.count, 1)
        h.finish(9 / 16.0)
        for _ in 0..<12 { h.time += 1; h.follow.observe(followLayout(9 / 16.0)) }
        XCTAssertEqual(h.actions.count, 1)
        XCTAssertEqual(h.follow.phase, "matched")
        h.stable(1 / 1.5)
        XCTAssertEqual(h.actions.count, 2)
        XCTAssertEqual(h.actions.last?.target, "landscape")
        h.finish(16 / 9.0)
        for _ in 0..<12 { h.time += 1; h.follow.observe(followLayout(16 / 9.0)) }
        XCTAssertEqual(h.actions.count, 2)
    }
    func testLiveStyleCropResetIsVerifiedAndQuarantinedUntilFreshPhoneShape() throws {
        let h = FollowHarness()
        h.initial = VideoFollowSettings(enabled: true, calibrations: ["test peer": VideoFollowCalibration(portrait: 2.175, landscape: 1.5, portraitLocalAxis: "portrait", landscapeLocalAxis: "portrait")])
        h.stable(1 / 1.5)
        XCTAssertEqual(h.actions.first?.target, "landscape")
        let action = try XCTUnwrap(h.actions.first)
        XCTAssertTrue(h.follow.permits(followLayout(16 / 9.0), action: action, afterAttempt: true), "Own crop reset must not invalidate post-click verification")
        h.finish(16 / 9.0)
        XCTAssertEqual(h.follow.phase, "matched")
        for _ in 0..<12 { h.time += 1; h.follow.observe(followLayout(16 / 9.0)) }
        XCTAssertEqual(h.actions.count, 1)
        h.stable(1.5) // Fresh phone portrait signal while the local camera is landscape: axes differ.
        XCTAssertEqual(h.actions.count, 2)
        XCTAssertEqual(h.actions.last?.target, "portrait")
        h.finish(9 / 16.0)
        for _ in 0..<12 { h.time += 1; h.follow.observe(followLayout(9 / 16.0)) }
        XCTAssertEqual(h.actions.count, 2)
        XCTAssertEqual(h.follow.phase, "matched")
    }
    func testOwnCropMatchingOtherPhoneCalibrationCannotReverseTheTarget() throws {
        let h = FollowHarness(); h.stable(1.5)
        h.finish(1 / 1.5) // Correct portrait axis, but crop would otherwise imply mismatched axes.
        for _ in 0..<12 { h.time += 1; h.follow.observe(followLayout(1 / 1.5)) }
        XCTAssertEqual(h.actions.count, 1)
        XCTAssertEqual(h.follow.phase, "matched")
    }
    func testAlreadyMatchingCameraNeverClicks() throws {
        let h = FollowHarness()
        h.stable(1 / 2.17)
        h.stable(2.17)
        XCTAssertTrue(h.actions.isEmpty)
    }
    func testFailedOrUnverifiedRotationPausesRatherThanRetriesSamePhoneState() throws {
        for changed in [false, true] {
            let h = FollowHarness(); h.stable(1.5)
            h.finish(1.5, changed: changed) // Wrong axis even if some geometry changed.
            for _ in 0..<12 { h.time += 1; h.follow.observe(followLayout(1.5)) }
            XCTAssertEqual(h.actions.count, 1)
            XCTAssertEqual(h.follow.phase, "paused_after_failure")
            h.follow.observe(followLayout(1.8)) // Temporary unrecognized geometry must not unlock retry.
            h.stable(1.5)
            XCTAssertEqual(h.actions.count, 1)
        }
    }
    func testTransientMissingViewDoesNotUnlockFailedOrUncertainClick() throws {
        for finishBeforeMissing in [false, true] {
            let h = FollowHarness(); h.stable(1.5)
            if finishBeforeMissing { h.finish(1.5, changed: false) }
            h.follow.observe(nil)
            if !finishBeforeMissing { h.finish(1.5, changed: false) }
            h.time += 6
            h.stable(1.5)
            XCTAssertEqual(h.actions.count, 1)
            XCTAssertEqual(h.follow.phase, "paused_after_failure")
        }
    }
    func testFreshDifferentPhoneStateCanReleaseFailureLatch() throws {
        let h = FollowHarness(); h.stable(1.5)
        h.callbacks.removeFirst()(.failure(VideoLayoutError(code: "failed", message: "failed")))
        h.time += 6
        h.stable(2.17) // Different state, already matching.
        h.stable(1.5)
        XCTAssertEqual(h.actions.count, 2)
    }
    func testUnknownUncalibratedAndUnapprovedCallersNeverRotate() throws {
        let h = FollowHarness()
        h.isAllowed = false; h.stable(1.5)
        XCTAssertTrue(h.actions.isEmpty)
        h.isAllowed = true
        for _ in 0..<3 { h.time += 2; h.follow.observe(followLayout(1.5, peer: "Different Phone")) }
        h.stable(1.8)
        XCTAssertTrue(h.actions.isEmpty)
    }
    func testMissingOrReplacedVideoContextResetsDebounce() throws {
        let h = FollowHarness()
        h.follow.observe(followLayout(1.5))
        h.time += 2; h.follow.observe(nil)
        h.follow.observe(followLayout(1.5))
        XCTAssertTrue(h.actions.isEmpty)
        h.time += 2; h.follow.observe(followLayout(1.5, id: "43:SceneWindow"))
        XCTAssertTrue(h.actions.isEmpty)
    }
    func testDisableAndAllowlistRevocationCancelAuthorizationForPendingClick() throws {
        let h = FollowHarness(); h.stable(1.5)
        let action = try XCTUnwrap(h.actions.first)
        XCTAssertTrue(h.follow.permits(followLayout(1.5), action: action, afterAttempt: false))
        XCTAssertFalse(h.follow.permits(followLayout(1 / 1.5), action: action, afterAttempt: false), "No toggle if already corrected externally")
        XCTAssertTrue(h.follow.permits(followLayout(1 / 1.5), action: action, afterAttempt: true))
        h.isAllowed = false
        XCTAssertFalse(h.follow.permits(followLayout(1.5), action: action, afterAttempt: false))
        h.isAllowed = true
        try h.follow.setEnabled(false)
        XCTAssertFalse(h.follow.permits(followLayout(1.5), action: action, afterAttempt: false))
        h.finish(1 / 1.5)
        XCTAssertEqual(h.follow.phase, "disabled")
        XCTAssertEqual(h.events.count, 1, "Late completion cannot publish success after disable")
    }
    func testManualBusyAndInflightRotationDoNotQueueActions() throws {
        let h = FollowHarness()
        h.follow.observe(followLayout(1.5), manualBusy: true)
        h.time += 2; h.follow.observe(followLayout(1.5), manualBusy: true)
        XCTAssertTrue(h.actions.isEmpty)
        h.stable(1.5)
        for _ in 0..<10 { h.time += 2; h.follow.observe(followLayout(1 / 2.17)) }
        XCTAssertEqual(h.actions.count, 1)
    }
    func testCalibrationIsExplicitPausesFollowAndRequiresDistinctPair() throws {
        let h = FollowHarness(); h.initial = VideoFollowSettings()
        XCTAssertThrowsError(try h.follow.setEnabled(true))
        let first = try h.follow.calibrate(orientation: "portrait", layout: followLayout(1.5), expectedWindowID: "42:SceneWindow", expectedPeer: "Test Peer")
        XCTAssertEqual(first["complete"] as? Bool, false)
        _ = try h.follow.calibrate(orientation: "landscape", layout: followLayout(2.17), expectedWindowID: "42:SceneWindow", expectedPeer: "Test Peer")
        XCTAssertFalse(h.follow.settings.enabled)
        try h.follow.setEnabled(true)
        XCTAssertTrue(h.follow.settings.enabled)
        XCTAssertTrue(h.saved.last?.enabled == true)
        h.isAllowed = false
        XCTAssertThrowsError(try h.follow.calibrate(orientation: "portrait", layout: followLayout(1.5), expectedWindowID: "42:SceneWindow", expectedPeer: "Test Peer"))
    }
    func testAppUsesStandardPreferencesWithoutOpeningItsOwnSuite() throws {
        let suiteName = "test.video-follow.\(UUID().uuidString)"
        let standard = UserDefaults(suiteName: suiteName)!
        defer { standard.removePersistentDomain(forName: suiteName) }
        let selected = VideoFollowStore.preferences(bundleIdentifier: "dev.mypi.facetime-bridge", standard: standard,
            suite: { _ in XCTFail("Foundation rejects own-bundle suite; do not request it"); return nil })
        XCTAssertTrue(selected === standard)
    }
    func testCLISelectsAppDomainAndUnavailableSuiteIsNotForceUnwrapped() throws {
        let suiteName = "test.video-follow.\(UUID().uuidString)"
        let shared = UserDefaults(suiteName: suiteName)!
        defer { shared.removePersistentDomain(forName: suiteName) }
        var requested: String?
        let selected = VideoFollowStore.preferences(bundleIdentifier: nil, suite: { requested = $0; return shared })
        XCTAssertEqual(requested, "dev.mypi.facetime-bridge")
        XCTAssertTrue(selected === shared)
        XCTAssertNil(VideoFollowStore.preferences(bundleIdentifier: nil, suite: { _ in nil }))
    }
    func testPreferencesPersistPerTalkConfigPathButNeverStoreCallingPermission() throws {
        let suite = "test.video-follow.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let a = VideoFollowStore(configPath: "/tmp/a/talk.json", defaults: defaults)
        let b = VideoFollowStore(configPath: "/tmp/b/talk.json", defaults: defaults)
        let settings = VideoFollowSettings(enabled: true, calibrations: ["test peer": VideoFollowCalibration(portrait: 1.5, landscape: 2.17, portraitLocalAxis: "landscape", landscapeLocalAxis: "landscape")])
        try a.save(settings)
        XCTAssertTrue(try a.load().enabled)
        XCTAssertFalse(try b.load().enabled)
        defaults.set(Data("broken JSON".utf8), forKey: a.key)
        XCTAssertThrowsError(try a.load())
    }
    func testInvalidationBlocksFutureObservationsAndLateCompletion() throws {
        let h = FollowHarness(); h.stable(1.5)
        h.follow.invalidate(); h.finish(1 / 1.5)
        h.time += 20; h.stable(1.5)
        XCTAssertEqual(h.actions.count, 1)
        XCTAssertEqual(h.events.count, 1)
    }
}
