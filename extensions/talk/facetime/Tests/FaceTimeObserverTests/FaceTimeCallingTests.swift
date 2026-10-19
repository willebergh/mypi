import Foundation
import XCTest
@testable import FaceTimeObserver

// Synthetic only: never open a URL, invoke AX, or place a call.
final class FaceTimeCallingTests: XCTestCase {
    func testMediaDefaultsOnlyWhenOmittedAndRejectsUnknownArguments() throws {
        let base: [String: Any] = ["type": "command", "command": "call", "id": "test", "to": "owner@example.invalid"]
        XCTAssertEqual(try FaceTimeCallMedia.fromCommand(base), .audio)
        for (value, expected) in [("audio", FaceTimeCallMedia.audio), ("video", .video)] {
            var command = base
            command["media"] = value
            XCTAssertEqual(try FaceTimeCallMedia.fromCommand(command), expected)
        }
        let invalid: [Any] = [NSNull(), "", "VIDEO", "unknown", true, 1, [], [:]]
        for value in invalid {
            var command = base
            command["media"] = value
            XCTAssertThrowsError(try FaceTimeCallMedia.fromCommand(command)) { error in
                XCTAssertEqual((error as? FaceTimeCallRequestError)?.code, "invalid_media")
            }
        }
        var unknown = base
        unknown["video"] = true
        XCTAssertThrowsError(try FaceTimeCallMedia.fromCommand(unknown)) { error in
            XCTAssertEqual((error as? FaceTimeCallRequestError)?.code, "invalid_command")
        }
    }

    func testVideoUsesAppleDocumentedSchemeAndAudioDefaultIsUnchanged() {
        let recipient = "owner@example.invalid"
        XCTAssertEqual(faceTimeCallURL(to: recipient)?.absoluteString, "facetime-audio://owner%40example.invalid")
        XCTAssertEqual(faceTimeCallURL(to: recipient, media: .audio)?.scheme, "facetime-audio")
        XCTAssertEqual(faceTimeCallURL(to: recipient, media: .video)?.absoluteString, "facetime://owner%40example.invalid")
        XCTAssertEqual(faceTimeCallURL(to: "+46000000000", media: .video)?.scheme, "facetime")
        let encoded = faceTimeCallURL(to: "owner/other?x#y@example.invalid", media: .video)?.absoluteString
        XCTAssertTrue(encoded?.contains("%2F") == true)
        XCTAssertTrue(encoded?.contains("%3F") == true)
        XCTAssertTrue(encoded?.contains("%23") == true)
    }

    func testConfirmationMediaIsFailClosedForVideoAndNeverClicksAnExplicitMismatch() throws {
        let generic = try XCTUnwrap(CallConfirmation.fromBannerStrings(["Owner, Click to Call", "Call", "Cancel"]))
        XCTAssertNil(generic.media)
        XCTAssertTrue(generic.permits(.audio), "legacy generic audio confirmation remains supported")
        XCTAssertFalse(generic.permits(.video), "the requested URL alone is not video confirmation evidence")
        let audio = try XCTUnwrap(CallConfirmation.fromBannerStrings(["Owner, Click to Call", "FaceTime Audio", "Call"]))
        XCTAssertTrue(audio.permits(.audio))
        XCTAssertFalse(audio.permits(.video))
        let video = try XCTUnwrap(CallConfirmation.fromBannerStrings(["Owner, Click to Call", "FaceTime Video", "Call"]))
        XCTAssertEqual(video.identity, "Owner")
        XCTAssertTrue(video.permits(.video))
        XCTAssertFalse(video.permits(.audio))
        let conflict = try XCTUnwrap(CallConfirmation.fromBannerStrings(["Owner, Click to Call", "FaceTime Audio", "FaceTime Video", "Call"]))
        XCTAssertTrue(conflict.conflictingMedia)
        XCTAssertFalse(conflict.permits(.audio))
        XCTAssertFalse(conflict.permits(.video))
        let localized = try XCTUnwrap(CallConfirmation.fromBannerStrings(["Owner, Click to Call", "Unknown media label", "Call"]))
        XCTAssertFalse(localized.permits(.video))
        let choices = try XCTUnwrap(CallConfirmation.fromBannerStrings(["Owner, Click to Call", "Video", "Call"]))
        XCTAssertFalse(choices.permits(.video), "an unvalidated bare option label is not selected-media evidence")
        XCTAssertFalse(choices.permits(.audio), "do not blindly accept a possibly-video control for audio")
        XCTAssertNil(CallConfirmation.fromBannerStrings(["Owner, Click to Call", "Other, Click to Call", "FaceTime Video"]))
    }

    func testConfirmationCannotBorrowMediaFromAnotherBannerOrProcess() throws {
        let generic = banner(identity: "Owner", media: nil)
        let other = banner(identity: "Other", media: "FaceTime Video")
        let notification: [String: Any] = ["process": ["bundleIdentifier": "com.apple.notificationcenterui"], "tree": ["children": [generic]]]
        let unrelated: [String: Any] = ["process": ["bundleIdentifier": "com.example.other"], "tree": other]
        let confirmation = try XCTUnwrap(CallConfirmation.extract(from: [notification, unrelated]))
        XCTAssertFalse(confirmation.permits(.video))
        let multiple: [String: Any] = ["process": ["bundleIdentifier": "com.apple.notificationcenterui"], "tree": ["children": [generic, other]]]
        XCTAssertNil(CallConfirmation.extract(from: [multiple]))
        let video: [String: Any] = ["process": ["bundleIdentifier": "com.apple.notificationcenterui"], "tree": banner(identity: "Owner", media: "FaceTime Video")]
        XCTAssertTrue(CallConfirmation.extract(from: [video])?.permits(.video) == true)
        XCTAssertFalse(CallObservation.extract(from: [video]).present, "confirmation is not ringing or connection")
    }

    func testRequestedMediaDoesNotInventObservedMediaOrConnection() {
        for media in [FaceTimeCallMedia.audio, .video] {
            let tracker = CallStateTracker()
            XCTAssertNotNil(tracker.beginOutgoingRequest(identity: "Owner", media: media))
            XCTAssertEqual(tracker.statusJSON["requestedMedia"] as? String, media.rawValue)
            XCTAssertTrue(tracker.statusJSON["media"] is NSNull)
            XCTAssertEqual(tracker.statusJSON["verified"] as? Bool, false)
            XCTAssertTrue(tracker.update(CallObservation()).isEmpty)
            var first = CallObservation(present: true, identity: "Owner", media: media.rawValue, durationSeconds: media == .audio ? 0 : nil, hasEnd: true)
            if media == .video { first.videoWindowID = "42:SceneWindow"; first.videoParticipantsPresent = true }
            _ = tracker.update(first)
            XCTAssertNotEqual(tracker.phase, "connected")
            var second = first
            if media == .audio { second.durationSeconds = 2 }
            let connected = tracker.update(second)
            XCTAssertEqual(connected.first?["event"] as? String, "call.connected")
            XCTAssertEqual(connected.first?["requestedMedia"] as? String, media.rawValue)
            XCTAssertEqual(connected.first?["media"] as? String, media.rawValue)
            _ = tracker.forceFailed(evidence: "synthetic_timeout")
            XCTAssertNil(tracker.requestedMedia)
        }
        let defaultAudio = CallStateTracker()
        _ = defaultAudio.beginOutgoingRequest(identity: "Owner")
        XCTAssertEqual(defaultAudio.requestedMedia, .audio)
        XCTAssertNil(defaultAudio.observation.media)
    }

    func testIncomingVideoObservationRemainsIndependentOfOutgoingIntent() {
        let snapshot: [String: Any] = ["process": ["bundleIdentifier": "com.apple.notificationcenterui"], "tree": [
            "AXIdentifier": "FACETIME_NOTIFICATION", "children": [
                ["AXDescription": "Owner, FaceTime Video"], ["AXDescription": "Answer"], ["AXDescription": "Decline"]
            ]
        ]]
        let observation = CallObservation.extract(from: [snapshot])
        XCTAssertEqual(observation.media, "video")
        XCTAssertEqual(observation.direction, "incoming")
        let tracker = CallStateTracker()
        XCTAssertEqual(tracker.update(observation).first?["event"] as? String, "call.incoming")
        XCTAssertNil(tracker.requestedMedia)
    }

    private func banner(identity: String, media: String?) -> [String: Any] {
        var children: [[String: Any]] = [["AXDescription": "\(identity), Click to Call"], ["AXRole": "AXButton", "AXDescription": "Call"]]
        if let media { children.append(["AXDescription": media]) }
        return ["AXIdentifier": "FACETIME_NOTIFICATION", "children": children]
    }
}
