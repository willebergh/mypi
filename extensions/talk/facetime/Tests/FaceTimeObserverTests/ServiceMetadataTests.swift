import XCTest
@testable import FaceTimeObserver

final class ServiceMetadataTests: XCTestCase {
    func testInstanceIdentityAndSnapshotWatermark() {
        var metadata = ServiceMetadata()
        XCTAssertNotNil(UUID(uuidString: metadata.serviceInstanceId))
        XCTAssertNotEqual(metadata.serviceInstanceId, ServiceMetadata().serviceInstanceId)
        let initial = metadata.snapshot(["type": "snapshot"], allowedCallers: [])
        XCTAssertEqual(initial["seq"] as? UInt64, 0)
        let event = metadata.event(["type": "event", "event": "bridge.status"], allowedCallers: [])
        let diagnostic = metadata.event(["type": "diagnostic"], allowedCallers: [])
        let snapshot = metadata.snapshot(["type": "snapshot"], allowedCallers: [])
        XCTAssertEqual(event["seq"] as? UInt64, 1)
        XCTAssertEqual(snapshot["seq"] as? UInt64, 1)
        XCTAssertNil(diagnostic["seq"])
        for record in [initial, event, diagnostic, snapshot, metadata.envelope(["type": "response", "ok": true])] {
            XCTAssertEqual(record["serviceInstanceId"] as? String, metadata.serviceInstanceId)
            XCTAssertEqual(record["protocolVersion"] as? Int, 1)
        }
    }

    func testIncomingAllowedMatchesSwiftAllowlistInEventsAndSnapshots() {
        for (identity, allowed) in [("  TEST@Example.com ", true), ("Other", false), ("", false)] {
            var metadata = ServiceMetadata()
            let allowlist = ["test@example.com", ""]
            let event = metadata.event(["type": "event", "event": "call.incoming", "identity": identity], allowedCallers: allowlist)
            let snapshot = metadata.snapshot(["type": "snapshot", "call": ["phase": "incoming", "identity": identity]], allowedCallers: allowlist)
            XCTAssertEqual(event["allowed"] as? Bool, allowed)
            XCTAssertEqual((snapshot["call"] as? [String: Any])?["allowed"] as? Bool, allowed)
        }
        var metadata = ServiceMetadata()
        let unidentified = metadata.event(["type": "event", "event": "call.incoming", "identity": NSNull()], allowedCallers: ["Caller"])
        XCTAssertEqual(unidentified["allowed"] as? Bool, false)
        let unidentifiedSnapshot = metadata.snapshot(["call": ["phase": "incoming", "identity": NSNull()]], allowedCallers: ["Caller"])
        XCTAssertEqual((unidentifiedSnapshot["call"] as? [String: Any])?["allowed"] as? Bool, false)
        let idle = metadata.snapshot(["call": ["phase": "idle"]], allowedCallers: [])
        XCTAssertNil((idle["call"] as? [String: Any])?["allowed"])
        XCTAssertTrue(callerIsAllowed("+46 70-123 45 67", allowedCallers: ["+46701234567"]))
    }

    func testEndRequiresFaceTimeBannerScopeWithoutIdentityTargeting() {
        XCTAssertFalse(semanticPressMatches(label: "End", title: "End", description: nil, insideFaceTimeBanner: false))
        XCTAssertFalse(semanticPressMatches(label: "end", title: nil, description: "END", insideFaceTimeBanner: false))
        XCTAssertTrue(semanticPressMatches(label: "End", title: nil, description: "End", insideFaceTimeBanner: true))
        XCTAssertFalse(semanticPressMatches(label: "End", title: "End Meeting", description: nil, insideFaceTimeBanner: true))
    }
}
