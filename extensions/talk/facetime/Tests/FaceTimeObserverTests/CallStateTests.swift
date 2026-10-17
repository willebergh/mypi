import XCTest
@testable import FaceTimeObserver

final class CallStateTests: XCTestCase {
    func testOutgoingRequiresAdvancingTimerBeforeConnected() {
        let tracker = CallStateTracker()

        var events = tracker.update(.extract(from: [snapshot(description: "Test Caller, FaceTime Audio…", controls: ["Mute", "End"])]))
        XCTAssertEqual(events.map { $0["event"] as? String }, ["call.dialing"])
        XCTAssertEqual(tracker.phase, "dialing")

        events = tracker.update(.extract(from: [snapshot(description: "Test Caller, FaceTime Audio - , 0:00", controls: ["Mute", "End"])]))
        XCTAssertEqual(events.map { $0["event"] as? String }, ["call.unknown"])
        XCTAssertEqual(tracker.phase, "dialing")

        events = tracker.update(.extract(from: [snapshot(description: "Test Caller, FaceTime Audio - , 0:02", controls: ["Mute", "End"])]))
        XCTAssertEqual(events.map { $0["event"] as? String }, ["call.connected"])
        XCTAssertEqual(events.first?["verified"] as? Bool, true)
        XCTAssertEqual(tracker.phase, "connected")
    }

    func testConnectedTimerDisappearsBeforeRemoteHangup() {
        for participantLeft in [true, false] {
            let tracker = CallStateTracker()
            _ = tracker.update(.extract(from: [snapshot(description: "Test Caller, FaceTime Audio…", controls: ["Mute", "End"])]))
            _ = tracker.update(.extract(from: [snapshot(description: "Test Caller, FaceTime Audio - , 0:00", controls: ["Mute", "End"])]))
            let connected = tracker.update(.extract(from: [snapshot(description: "Test Caller, FaceTime Audio - , 0:03", controls: ["Mute", "End"])]))
            XCTAssertEqual(connected.first?["event"] as? String, "call.connected")
            let callID = tracker.callID

            let lingeringEnd = CallObservation.extract(from: [snapshot(description: "Test Caller, FaceTime Audio…", controls: ["Mute", "End"])])
            XCTAssertNil(lingeringEnd.durationSeconds)
            XCTAssertTrue(tracker.update(lingeringEnd).isEmpty, "Must not emit another dialing event")
            XCTAssertEqual(tracker.phase, "connected")
            XCTAssertEqual(tracker.statusJSON["verified"] as? Bool, true)
            XCTAssertEqual(tracker.callID, callID)

            let ended: [[String: Any]]
            if participantLeft {
                ended = tracker.update(.extract(from: [endedSnapshot(description: "FaceTime, Test Caller, Test Caller left")]))
            } else {
                XCTAssertTrue(tracker.update(CallObservation()).isEmpty)
                XCTAssertEqual(tracker.phase, "connected")
                ended = tracker.update(CallObservation())
            }
            XCTAssertEqual(ended.map { $0["event"] as? String }, ["call.ended"])
            XCTAssertEqual(ended.first?["callId"] as? String, callID)
            XCTAssertEqual(ended.first?["evidence"] as? String, participantLeft ? "participant_left" : "ui_disappeared")
            XCTAssertEqual(ended.first?["verified"] as? Bool, participantLeft)
            XCTAssertEqual(tracker.phase, "idle")
            XCTAssertNil(tracker.callID)
        }
    }

    func testPreconnectionRemoteHangupStillFails() {
        let tracker = CallStateTracker()
        _ = tracker.update(.extract(from: [snapshot(description: "Test Caller, FaceTime Audio…", controls: ["Mute", "End"])]))
        _ = tracker.update(.extract(from: [snapshot(description: "Test Caller, FaceTime Audio - , 0:00", controls: ["Mute", "End"])]))
        XCTAssertEqual(tracker.phase, "dialing")
        XCTAssertTrue(tracker.update(.extract(from: [snapshot(description: "Test Caller, FaceTime Audio…", controls: ["Mute", "End"])])).isEmpty)

        let failed = tracker.update(.extract(from: [endedSnapshot(description: "FaceTime, Test Caller, Test Caller left")]))
        XCTAssertEqual(failed.map { $0["event"] as? String }, ["call.failed"])
        XCTAssertEqual(failed.first?["evidence"] as? String, "remote_declined_or_ended")
        XCTAssertEqual(failed.first?["verified"] as? Bool, true)
        XCTAssertEqual(tracker.phase, "idle")
    }

    func testExplicitFailureAfterConnectionStillFails() {
        let tracker = CallStateTracker()
        _ = tracker.update(CallObservation(present: true, durationSeconds: 0, hasEnd: true))
        _ = tracker.update(CallObservation(present: true, durationSeconds: 3, hasEnd: true))
        XCTAssertEqual(tracker.phase, "connected")

        let failed = tracker.update(CallObservation(present: true, hasEnd: true, failureReason: "Call Failed"))
        XCTAssertEqual(failed.map { $0["event"] as? String }, ["call.failed"])
        XCTAssertEqual(failed.first?["evidence"] as? String, "Call Failed")
        XCTAssertEqual(failed.first?["verified"] as? Bool, true)
        XCTAssertEqual(tracker.phase, "idle")
    }

    func testIncomingIdentityAndEnd() {
        let tracker = CallStateTracker()
        let incoming = CallObservation.extract(from: [snapshot(description: "\u{202A}Test Caller\u{202C}, FaceTime Audio", controls: ["Answer", "Decline"])])
        let events = tracker.update(incoming)

        XCTAssertEqual(incoming.identity, "Test Caller")
        XCTAssertEqual(incoming.direction, "incoming")
        XCTAssertEqual(events.first?["event"] as? String, "call.incoming")

        _ = tracker.update(.extract(from: [snapshot(description: "Test Caller, FaceTime Audio - , 0:00", controls: ["Mute", "End"])]))
        _ = tracker.update(.extract(from: [snapshot(description: "Test Caller, FaceTime Audio - , 0:02", controls: ["Mute", "End"])]))
        let ended = tracker.update(.extract(from: [endedSnapshot(description: "FaceTime, Test Caller, Test Caller left")]))
        XCTAssertEqual(ended.first?["event"] as? String, "call.ended")
        XCTAssertEqual(ended.first?["direction"] as? String, "incoming")
        XCTAssertEqual(ended.first?["verified"] as? Bool, true)
        XCTAssertEqual(tracker.phase, "idle")
    }

    func testClickToCallConfirmationIsNotTreatedAsRinging() {
        let confirmationSnapshot = snapshot(description: "Test Caller, Click to Call", controls: ["Call", "Cancel"])
        XCTAssertEqual(CallConfirmation.extract(from: [confirmationSnapshot])?.identity, "Test Caller")
        XCTAssertFalse(CallObservation.extract(from: [confirmationSnapshot]).present)
    }

    func testOutgoingRequestWaitsForUIAndFailsIfRingingDisappears() {
        let tracker = CallStateTracker()
        XCTAssertEqual(tracker.beginOutgoingRequest(identity: "Test Caller"), "local-1")
        XCTAssertTrue(tracker.update(CallObservation()).isEmpty)
        XCTAssertEqual(tracker.phase, "starting")

        _ = tracker.update(.extract(from: [snapshot(description: "Test Caller, FaceTime Audio…", controls: ["Mute", "End"])]))
        XCTAssertEqual(tracker.phase, "dialing")
        XCTAssertTrue(tracker.update(CallObservation()).isEmpty)
        let failed = tracker.update(CallObservation())
        XCTAssertEqual(failed.first?["event"] as? String, "call.failed")
        XCTAssertEqual(failed.first?["evidence"] as? String, "call_ui_disappeared_before_connection")
    }

    func testStaleFailureBannerDoesNotCreateRepeatedCalls() {
        let tracker = CallStateTracker()
        _ = tracker.update(.extract(from: [snapshot(description: "Test Caller, FaceTime Audio", controls: ["Answer", "Decline"])]))
        let failure = CallObservation.extract(from: [snapshot(description: "Test Caller, Call Failed", controls: [])])
        XCTAssertEqual(tracker.update(failure).first?["event"] as? String, "call.failed")
        XCTAssertTrue(tracker.update(failure).isEmpty)
        XCTAssertNil(tracker.callID)
    }

    func testLocalHangupIsReported() {
        let tracker = CallStateTracker()
        _ = tracker.update(.extract(from: [snapshot(description: "Test Caller, FaceTime Audio…", controls: ["Mute", "End"])]))
        _ = tracker.update(.extract(from: [snapshot(description: "Test Caller, FaceTime Audio - , 0:00", controls: ["Mute", "End"])]))
        _ = tracker.update(.extract(from: [snapshot(description: "Test Caller, FaceTime Audio - , 0:02", controls: ["Mute", "End"])]))
        tracker.markLocalHangupRequested()
        _ = tracker.update(CallObservation())
        let ended = tracker.update(CallObservation())
        XCTAssertEqual(ended.first?["event"] as? String, "call.ended")
        XCTAssertEqual(ended.first?["evidence"] as? String, "local_hangup")
        XCTAssertEqual(ended.first?["verified"] as? Bool, true)
    }

    func testIdentityNormalization() {
        XCTAssertEqual(normalizedIdentity("  TEST@Example.COM "), "test@example.com")
        XCTAssertEqual(normalizedIdentity("+46 70-123 45 67"), "+46701234567")
        XCTAssertEqual(normalizedIdentity("  Test   Caller "), "test caller")
    }

    private func snapshot(description: String, controls: [String]) -> [String: Any] {
        [
            "process": ["bundleIdentifier": "com.apple.notificationcenterui"],
            "tree": [
                "children": [[
                    "AXRole": "AXGroup",
                    "AXIdentifier": "FACETIME_NOTIFICATION",
                    "children": [
                        ["AXRole": "AXGenericElement", "AXDescription": "FaceTime Audio"],
                        ["AXRole": "AXGenericElement", "AXDescription": description],
                        ["AXRole": "AXGroup", "children": controls.map { ["AXRole": "AXButton", "AXDescription": $0] }]
                    ]
                ]]
            ]
        ]
    }

    private func endedSnapshot(description: String) -> [String: Any] {
        [
            "process": ["bundleIdentifier": "com.apple.notificationcenterui"],
            "tree": ["children": [["AXRole": "AXGroup", "AXDescription": description]]]
        ]
    }
}
