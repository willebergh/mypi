import XCTest
@testable import FaceTimeObserver

// Invented identities; structures mirror the manually captured ringing and
// answered video layouts. These tests never access live AX or place calls.
final class VideoCallUITests: XCTestCase {
    private let peer = "Synthetic Owner"
    private let owner = "owner@example.invalid"
    private var allowed: [String] { [peer, owner] }
    private func text(_ value: String) -> [String: Any] { ["AXRole": "AXStaticText", "AXValue": value] }
    private func button(_ label: String) -> [String: Any] {
        ["AXRole": "AXButton", "AXDescription": label, "AXEnabled": true, "actions": ["AXPress"]]
    }
    private func app(_ children: [[String: Any]]) -> [String: Any] {
        ["process": ["pid": 42, "bundleIdentifier": "com.apple.FaceTime"], "tree": ["AXRole": "AXApplication", "children": children]]
    }
    private func video(peer: String = "Synthetic Owner", connected: Bool = true, windowID: String = "SceneWindow", controls: Bool = true, duplicateRemote: Bool = false, auxiliary: Bool = false) -> [String: Any] {
        var contents: [[String: Any]] = []
        if connected {
            let remote: [String: Any] = ["AXRole": "AXButton", "AXDescription": peer, "AXValue": "", "AXSize": ["width": 427, "height": 640], "actions": ["AXPress"]]
            contents += [
                ["AXRole": "AXGenericElement", "AXIdentifier": "ParticipantGridView", "AXSize": ["width": 427, "height": 640]],
                remote,
                ["AXRole": "AXButton", "AXIdentifier": "LocalParticipantView", "AXSize": ["width": 150, "height": 84]]
            ]
            if duplicateRemote { contents.append(remote) }
        }
        if controls {
            contents += [
                ["AXRole": "AXCheckBox", "AXDescription": "Camera"],
                ["AXRole": "AXCheckBox", "AXDescription": "Microphone"], button("End")
            ]
        }
        var children: [[String: Any]] = [["AXRole": "AXWindow", "AXSubrole": "AXStandardWindow", "AXIdentifier": windowID,
            "AXSize": ["width": 427, "height": 640], "children": [["AXRole": "AXGroup", "children": contents]]]]
        if auxiliary || !connected { children.append(["AXRole": "AXGroup", "children": [text(peer), text("Synthetic status without a duration")]]) }
        return app(children)
    }
    private func confirmation(identity: String = "Synthetic Owner", content: String = "Synthetic content") -> [String: Any] {
        app([["AXRole": "AXWindow", "AXSubrole": "AXStandardWindow", "children": [["children": [
            ["children": [text(identity), text(content)]], button("Cancel"), button("Call"), text("Cancel"), text("Call")
        ]]]]])
    }
    private func observation(_ fixture: [String: Any], allowed: [String]? = nil, windowID: String? = nil) throws -> CallObservation {
        try XCTUnwrap(VideoCallUI([fixture])?.observation(snapshots: [fixture], identities: allowed ?? self.allowed, expectedWindowID: windowID))
    }
    private func select(_ fixture: [String: Any], allowed: [String]? = nil, pending: Bool = true) -> VideoCallControl? {
        VideoCallUI([fixture])?.confirmation(identities: allowed ?? self.allowed, pendingVideo: pending)
    }
    func testCapturedRingingControlsDoNotMeanConnection() throws {
        let ringing = try observation(video(connected: false))
        XCTAssertTrue(ringing.present)
        XCTAssertTrue(ringing.hasEnd)
        XCTAssertFalse(ringing.videoParticipantsPresent)
        XCTAssertNil(ringing.durationSeconds)
        let tracker = CallStateTracker()
        _ = tracker.beginOutgoingRequest(identity: owner, media: .video)
        XCTAssertEqual(tracker.update(ringing).first?["event"] as? String, "call.dialing")
        for _ in 0..<4 { XCTAssertTrue(tracker.update(ringing).isEmpty) }
        XCTAssertEqual(tracker.phase, "dialing")
        XCTAssertEqual(tracker.statusJSON["verified"] as? Bool, false)
    }
    func testCapturedAnswerTransitionConnectsWithoutAnyTimerOrFullscreenAction() throws {
        let tracker = CallStateTracker()
        _ = tracker.beginOutgoingRequest(identity: owner, media: .video)
        _ = tracker.update(try observation(video(connected: false)))
        let answered = try observation(video())
        XCTAssertTrue(answered.videoParticipantsPresent)
        XCTAssertNil(answered.durationSeconds)
        XCTAssertNil(VideoLayout.extract([video()]), "rotation's fullscreen selector is intentionally not used by call tracking")
        let first = tracker.update(answered)
        XCTAssertEqual(first.first?["event"] as? String, "call.unknown")
        XCTAssertEqual(tracker.statusJSON["verified"] as? Bool, false)
        let second = tracker.update(answered)
        XCTAssertEqual(second.first?["event"] as? String, "call.connected")
        XCTAssertEqual(second.first?["evidence"] as? String, "stable_identity_matched_video_participants")
        XCTAssertEqual(tracker.statusJSON["verified"] as? Bool, true)
        XCTAssertTrue(tracker.update(answered).isEmpty, "one connected event")
    }
    func testMissedRingingStillRequiresTwoCompleteParticipantScenes() throws {
        let tracker = CallStateTracker()
        _ = tracker.beginOutgoingRequest(identity: owner, media: .video)
        let answered = try observation(video(controls: false))
        XCTAssertFalse(answered.hasEnd, "hover controls are not necessary")
        XCTAssertFalse(tracker.update(answered).contains { $0["event"] as? String == "call.connected" })
        XCTAssertEqual(tracker.update(answered).first?["event"] as? String, "call.connected")
    }
    func testUncertainOrRingingReadBreaksParticipantStability() throws {
        for uncertain in [false, true] {
            let tracker = CallStateTracker()
            _ = tracker.beginOutgoingRequest(identity: owner, media: .video)
            let answered = try observation(video())
            _ = tracker.update(answered)
            if uncertain { tracker.markVideoObservationUncertain() }
            else { _ = tracker.update(try observation(video(connected: false))) }
            XCTAssertFalse(tracker.update(answered).contains { $0["event"] as? String == "call.connected" })
            XCTAssertEqual(tracker.update(answered).first?["event"] as? String, "call.connected")
        }
    }
    func testChangedWindowOrPeerCannotBorrowStability() throws {
        for changed in [try observation(video(windowID: "Other")), try observation(video(peer: owner))] {
            let tracker = CallStateTracker()
            _ = tracker.beginOutgoingRequest(identity: owner, media: .video)
            _ = tracker.update(try observation(video()))
            XCTAssertFalse(tracker.update(changed).contains { $0["event"] as? String == "call.connected" })
        }
    }
    func testIdentityWindowAndRemoteAmbiguityFailClosed() throws {
        let wrong = video(peer: "Wrong Peer")
        XCTAssertNil(VideoCallUI([wrong])?.observation(snapshots: [wrong], identities: allowed, expectedWindowID: nil))
        let duplicate = video(duplicateRemote: true)
        XCTAssertNil(VideoCallUI([duplicate])?.observation(snapshots: [duplicate], identities: allowed, expectedWindowID: nil))
        let valid = video()
        XCTAssertNil(VideoCallUI([valid])?.observation(snapshots: [valid], identities: allowed, expectedWindowID: "Wrong Window"))
        var multiple = valid
        var tree = multiple["tree"] as! [String: Any]
        let windows = tree["children"] as! [[String: Any]]
        tree["children"] = windows + windows; multiple["tree"] = tree
        XCTAssertNil(VideoCallUI([multiple])?.participantContext())
        XCTAssertNil(VideoCallUI([valid, valid]))
        var truncated = valid; truncated["truncated"] = true
        XCTAssertNil(VideoCallUI([truncated]))
    }
    func testGridAndLocalWithoutRemoteNeverConnect() throws {
        var fixture = video()
        func removeRemote(_ node: [String: Any]) -> [String: Any] {
            var copy = node
            if let children = node["children"] as? [[String: Any]] {
                copy["children"] = children.filter { $0["AXDescription"] as? String != peer }.map(removeRemote)
            }
            return copy
        }
        fixture["tree"] = removeRemote(fixture["tree"] as! [String: Any])
        let ui = try XCTUnwrap(VideoCallUI([fixture]))
        XCTAssertNil(ui.participantContext())
        XCTAssertNil(ui.observation(snapshots: [fixture], identities: allowed, expectedWindowID: nil))
    }

    func testWholeFieldPhoneNamesAndEmailSafeguards() throws {
        let phone = "+46000000000"
        for identity in [phone, peer, owner, "Synthetic 46000000000"] {
            let formatted = "\u{2066}  \(identity.uppercased())  \u{2069}"
            XCTAssertNotNil(select(confirmation(identity: formatted), allowed: [identity]))
            XCTAssertTrue(try observation(video(peer: formatted), allowed: [identity]).videoParticipantsPresent)
            for prose in ["Call \(identity)?", "Recipient: \(identity)", "\(identity) is calling"] {
                XCTAssertNil(select(confirmation(identity: prose), allowed: [identity]))
                let fixture = video(peer: prose)
                XCTAssertNil(VideoCallUI([fixture])?.observation(snapshots: [fixture], identities: [identity], expectedWindowID: nil))
            }
        }
        for formatted in ["+46 (000) 000-000", "+46.000.000.000", "\u{2066}+46 000 000 000\u{2069}"] {
            XCTAssertNotNil(select(confirmation(identity: formatted), allowed: [phone]))
            XCTAssertTrue(try observation(video(peer: formatted), allowed: [phone]).videoParticipantsPresent)
        }
        for invalid in ["++46000000000", "(+46)000000000", "+46()000000000", "\(phone)\u{200b}", "\(phone)?"] {
            XCTAssertNil(select(confirmation(identity: invalid), allowed: [phone]))
        }
        XCTAssertEqual(normalizedIdentity("Call \(phone)?"), phone, "legacy audio normalization unchanged")
    }
    func testConfirmationRemainsSolePendingIdentityScopedAndMediaGuarded() {
        XCTAssertNotNil(select(confirmation()))
        XCTAssertNil(select(confirmation(), pending: false))
        XCTAssertNil(select(confirmation(identity: "Other", content: peer)))
        XCTAssertNil(select(confirmation(content: owner)), "ambiguous identities")
        for media in ["FaceTime Audio", "FaceTime Audio", "Audio", "Video", "Video Call"] {
            XCTAssertNil(select(confirmation(content: media)))
        }
        XCTAssertNil(CallConfirmation.extract(from: [confirmation()]))
        XCTAssertFalse(CallObservation.extract(from: [confirmation()]).present)
    }
    func testEndRequiresMatchingUniqueWindowAndIdentityWithoutFullscreenAction() throws {
        let fixture = video()
        let ui = try XCTUnwrap(VideoCallUI([fixture]))
        XCTAssertNotNil(ui.endControl(expectedWindowID: "42:SceneWindow", expectedIdentity: peer, identities: allowed))
        XCTAssertNil(ui.endControl(expectedWindowID: "42:Other", expectedIdentity: peer, identities: allowed))
        XCTAssertNil(ui.endControl(expectedWindowID: "42:SceneWindow", expectedIdentity: "Other", identities: allowed))
        XCTAssertNil(VideoCallUI([video(controls: false)])?.endControl(expectedWindowID: "42:SceneWindow", expectedIdentity: peer, identities: allowed))
        XCTAssertNotNil(VideoCallUI([video(connected: false)])?.endControl(expectedWindowID: "42:SceneWindow", expectedIdentity: peer, identities: allowed), "ringing End is still identity/window scoped")
        var attempts = VideoCallAttempts()
        XCTAssertTrue(attempts.claim(.end, callID: "one"))
        XCTAssertFalse(attempts.claim(.end, callID: "one"))
        XCTAssertTrue(attempts.claim(.confirmation, callID: "one"))
        XCTAssertFalse(attempts.claim(.confirmation, callID: "one"))
    }
    func testRetainedFailureCannotReconnectAndDisappearanceIsTerminalOnce() throws {
        let tracker = CallStateTracker()
        let id = tracker.beginOutgoingRequest(identity: owner, media: .video)
        XCTAssertEqual(tracker.retainVideoFailure(evidence: "synthetic")?["status"] as? String, "retained")
        let answered = try observation(video())
        for _ in 0..<3 { XCTAssertTrue(tracker.update(answered).isEmpty) }
        XCTAssertEqual(tracker.phase, "unconfirmed")
        XCTAssertNil(tracker.beginOutgoingRequest(identity: owner, media: .video))
        XCTAssertTrue(tracker.update(CallObservation()).isEmpty)
        let end = tracker.update(CallObservation())
        XCTAssertEqual(end.first?["event"] as? String, "call.ended")
        XCTAssertEqual(end.first?["status"] as? String, "terminal")
        XCTAssertEqual(end.first?["callId"] as? String, id)
        XCTAssertNil(tracker.callID)
        XCTAssertTrue(tracker.update(CallObservation()).isEmpty)
    }
    func testLocalHangupAndMediaMismatchPreserveSafety() throws {
        let tracker = CallStateTracker()
        _ = tracker.beginOutgoingRequest(identity: owner, media: .video)
        let answered = try observation(video())
        _ = tracker.update(answered); _ = tracker.update(answered)
        tracker.markLocalHangupRequested()
        _ = tracker.update(CallObservation())
        XCTAssertEqual(tracker.update(CallObservation()).first?["evidence"] as? String, "local_hangup")
        _ = tracker.beginOutgoingRequest(identity: owner, media: .video)
        XCTAssertEqual(tracker.update(CallObservation(present: true, media: "audio")).first?["event"] as? String, "call.failed")
        XCTAssertEqual(tracker.phase, "unconfirmed")
    }
    func testDiagnosticsContainNoPrivateValues() throws {
        let tracker = CallStateTracker()
        _ = tracker.beginOutgoingRequest(identity: owner, media: .video)
        let status = VideoCallDiagnostic.participants.statusJSON(tracker: tracker)
        XCTAssertEqual(status["connectionGate"] as? String, "waiting_for_stable_video_participants")
        let json = String(decoding: try JSONSerialization.data(withJSONObject: status), as: UTF8.self)
        for privateValue in [peer, owner, "SceneWindow", "root/"] { XCTAssertFalse(json.contains(privateValue)) }
        let answered = try observation(video())
        _ = tracker.update(answered); _ = tracker.update(answered)
        XCTAssertEqual(VideoCallDiagnostic.participants.statusJSON(tracker: tracker)["connectionGate"] as? String, "verified_stable_video_participants")
    }
}
