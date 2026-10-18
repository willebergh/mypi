import XCTest
@testable import FaceTimeObserver

private final class SharingClock {
    var time: TimeInterval = 0
    var pending: [(TimeInterval, () -> Void)] = []
    func schedule(_ delay: TimeInterval, _ action: @escaping () -> Void) { pending.append((time + delay, action)) }
    func step() {
        pending.sort { $0.0 < $1.0 }
        guard !pending.isEmpty else { return }
        let (due, action) = pending.removeFirst()
        time = max(time, due)
        action()
    }
    func drain(file: StaticString = #filePath, line: UInt = #line) {
        for _ in 0..<200 {
            if pending.isEmpty { return }
            step()
        }
        XCTFail("Unbounded sharing polling", file: file, line: line)
    }
}

private final class SharingAX: ScreenSharingAX {
    var panelOpen = false
    var faceTimeSelected = true
    var pickerOpen = false
    var active = false
    var remote = "1"
    var identity = "William Bergh"
    var displays = ["LS32A600U", "BenQ GL2460 (1)", "BenQ GL2460 (2)"]
    var applyControlOff = true
    var applyStop = true
    var showRemote = true
    var showSharingText = true
    var openWorks = true
    var tabWorks = true
    var presses: [String] = []
    var reads = 0
    var afterRead: (() -> Void)?
    var readError: (() -> ScreenSharingError?)?
    var beforePress: ((ScreenSharingNode) throws -> Void)?
    var transform: ((ScreenSharingUI) -> ScreenSharingUI)?

    func read() throws -> ScreenSharingUI {
        reads += 1
        if let error = readError?() { throw error }
        var children = [ScreenSharingNode(handle: 1, role: "AXMenuBarItem", identifier: "com.apple.menuextra.audiovideo")]
        if panelOpen {
            var controls = [ScreenSharingNode(handle: 2, role: "AXButton", description: "FaceTime"),
                            ScreenSharingNode(handle: 7, role: "AXButton", description: "Discord")]
            if faceTimeSelected {
                controls += [ScreenSharingNode(handle: 3, role: "AXButton", description: identity + ", FaceTime\u{00a0}Audio"),
                             ScreenSharingNode(handle: 4, role: "AXCheckBox", identifier: "facetime-share-toggle", value: active ? "1" : "0")]
                if active {
                    controls.append(ScreenSharingNode(handle: 6, role: "AXButton", description: "Stop Sharing"))
                    if showSharingText { controls.append(ScreenSharingNode(role: "AXStaticText", value: "Currently Sharing")) }
                    if showRemote { controls.append(ScreenSharingNode(handle: 5, role: "AXCheckBox", identifier: "allow-remote-control-toggle", value: remote)) }
                }
            } else {
                // Discord's generic controls are not eligible for any mutation.
                controls.append(ScreenSharingNode(handle: 8, role: "AXCheckBox", identifier: "discord-share-toggle", value: "0"))
            }
            children.append(ScreenSharingNode(role: "AXWindow", title: "Control Center", children: controls))
        }
        if pickerOpen {
            let groups = displays.enumerated().map { index, display in
                ScreenSharingNode(role: "AXHostingView", children: [ScreenSharingNode(handle: 10 + index, role: "AXButton", description: "Share " + display)])
            }
            children.append(ScreenSharingNode(role: "AXWindow", description: "Shared Content Picker Controls", children:
                groups + [ScreenSharingNode(handle: 20, role: "AXButton", description: "Share")]))
        }
        let ui = ScreenSharingUI(root: ScreenSharingNode(role: "AXApplication", children: children))
        afterRead?()
        return transform?(ui) ?? ui
    }

    func press(_ node: ScreenSharingNode) throws {
        presses.append(node.identifier ?? node.description ?? "unknown")
        try beforePress?(node)
        switch node.handle {
        case 1: if openWorks { panelOpen = true; pickerOpen = false }
        case 2: if tabWorks { faceTimeSelected = true }
        case 4: pickerOpen = true; panelOpen = false
        case 5: if applyControlOff { remote = "0" }
        case 6: if applyStop { active = false }
        case 10..<20: active = true; pickerOpen = false; panelOpen = false; remote = "1"
        default: XCTFail("Unexpected mutation: \(node)")
        }
    }
}

private final class SharingHarness {
    let clock = SharingClock()
    let ax = SharingAX()
    let run = ServiceRun()
    var call = ScreenSharingCall(id: "local-1", phase: "connected", verified: true, identity: "William Bergh")
    var verificationTimeout: TimeInterval = 2.7
    var cleanupTimeout: TimeInterval = 1.1
    lazy var controller = ScreenSharingController(ax: ax, currentCall: { [unowned self] in self.call },
        isRunning: { [unowned self] in self.run.isRunning }, now: { [unowned self] in self.clock.time },
        schedule: { [unowned self] delay, action in self.clock.schedule(delay, action) },
        verificationTimeout: verificationTimeout, cleanupTimeout: cleanupTimeout)
    var results: [Result<[String: Any], ScreenSharingError>] = []

    func execute(_ name: String = "screen.share", display: String = "LS32A600U", id: String = "local-1") throws {
        var json: [String: Any] = ["type": "command", "command": name, "id": "request-1"]
        if name != "screen.status" { json["expectedCallId"] = id }
        if name == "screen.share" { json["display"] = display }
        controller.execute(try ScreenSharingCommand(json)) { [unowned self] in self.results.append($0) }
    }
    var result: [String: Any]? {
        guard case .success(let result) = results.last else { return nil }
        return result
    }
    var error: ScreenSharingError? {
        guard case .failure(let error) = results.last else { return nil }
        return error
    }
}

final class ScreenSharingTests: XCTestCase {
    func testFreshBannerEvidenceRejectsFirstMissingBannerAndResetTimerDespiteDebouncedTracker() throws {
        let tracker = CallStateTracker()
        let connected = CallObservation(present: true, identity: "William Bergh", durationSeconds: 4, hasEnd: true)
        _ = tracker.update(connected)
        var advancing = connected
        advancing.durationSeconds = 5
        _ = tracker.update(advancing)
        let id = try XCTUnwrap(tracker.callID)
        XCTAssertTrue(screenSharingCall(tracker: tracker, fresh: advancing).matches(id: id))
        _ = tracker.update(CallObservation())
        XCTAssertTrue(tracker.observation.present, "Lifecycle debounce intentionally retains prior evidence")
        XCTAssertFalse(screenSharingCall(tracker: tracker, fresh: CallObservation()).matches(id: id))
        var restarted = advancing
        restarted.durationSeconds = 0
        XCTAssertFalse(screenSharingCall(tracker: tracker, fresh: restarted).matches(id: id))
        var failed = advancing
        failed.failureReason = "Call Failed"
        XCTAssertFalse(screenSharingCall(tracker: tracker, fresh: failed).matches(id: id))
    }

    func testPresentConnectedBannerIgnoresUnrelatedLeftMenuText() throws {
        let snapshot: [String: Any] = [
            "process": ["bundleIdentifier": "com.apple.notificationcenterui"],
            "tree": ["AXRole": "AXApplication", "children": [
                ["AXIdentifier": "FACETIME_NOTIFICATION", "children": [
                    ["AXDescription": "William Bergh, FaceTime Audio - , 2:17"],
                    ["AXDescription": "End"]
                ]],
                ["AXRole": "AXMenuBar", "children": [["AXRole": "AXMenuItem", "AXTitle": "Align Left"]]]
            ]]
        ]
        let tracker = CallStateTracker()
        _ = tracker.update(CallObservation(present: true, identity: "William Bergh", durationSeconds: 136, hasEnd: true))
        let fresh = CallObservation.extract(from: [snapshot])
        _ = tracker.update(fresh)
        XCTAssertTrue(fresh.present)
        XCTAssertTrue(fresh.participantLeft, "Legacy broad detector sees Align Left; it is not termination evidence with a live banner")
        XCTAssertTrue(screenSharingCall(tracker: tracker, fresh: fresh).matches(id: try XCTUnwrap(tracker.callID)))
        var missing = fresh
        missing.present = false
        XCTAssertFalse(screenSharingCall(tracker: tracker, fresh: missing).matches(id: tracker.callID!))
    }

    func testPickerStageDoesNotPressDisplayAfterFreshCallBannerDisappears() throws {
        let h = SharingHarness()
        try h.execute()
        h.clock.step() // open panel
        h.clock.step() // open picker
        XCTAssertTrue(h.ax.pickerOpen)
        h.call.present = false
        let previous = h.ax.presses
        h.clock.drain()
        XCTAssertEqual(h.error?.code, "stale_call")
        XCTAssertEqual(h.ax.presses, previous)
    }

    func testCommandValidationRequiresExactSafeDisplayAndCallIDAndRejectsUnknownArguments() throws {
        let valid: [String: Any] = ["type": "command", "command": "screen.share", "display": "BenQ GL2460 (2)", "expectedCallId": "local-1", "id": 7]
        let parsed = try ScreenSharingCommand(valid)
        XCTAssertEqual(parsed.display, "BenQ GL2460 (2)")
        XCTAssertEqual(parsed.expectedCallID, "local-1")
        for key in ["display", "expectedCallId"] {
            var missing = valid; missing.removeValue(forKey: key)
            XCTAssertThrowsError(try ScreenSharingCommand(missing))
            for bad: Any in ["", "   ", " leading", "trailing ", "a\nb", "a\u{0000}b", "a\u{202e}b", String(repeating: "x", count: 257), 42, NSNull()] {
                var invalid = valid; invalid[key] = bad
                XCTAssertThrowsError(try ScreenSharingCommand(invalid), "Accepted \(key)=\(bad)")
            }
        }
        var unknown = valid; unknown["allowControl"] = false
        XCTAssertThrowsError(try ScreenSharingCommand(unknown))
        XCTAssertThrowsError(try ScreenSharingCommand(["type": "command", "command": "screen.stop"]))
        XCTAssertThrowsError(try ScreenSharingCommand(["type": "command", "command": "screen.stop", "expectedCallId": "local-1", "display": "LS32A600U"]))
        for key in ["expectedCallId", "display", "openPanel"] {
            XCTAssertThrowsError(try ScreenSharingCommand(["type": "command", "command": "screen.status", key: "x"]))
        }
        XCTAssertNoThrow(try ScreenSharingCommand(["type": "command", "command": "screen.status"]))
    }

    func testExactUniqueDisplaySelectionAcrossHostingGroups() throws {
        let ax = SharingAX(); ax.pickerOpen = true
        let picker = try XCTUnwrap(ax.read().picker())
        XCTAssertEqual(try ScreenSharingUI.displayButton("LS32A600U", in: picker)?.handle, 10)
        XCTAssertEqual(try ScreenSharingUI.displayButton("BenQ GL2460 (2)", in: picker)?.handle, 12)
        for name in ["ls32a600u", "BenQ GL2460", "LS32", "", "Unknown"] {
            XCTAssertNil(try ScreenSharingUI.displayButton(name, in: picker))
        }
        ax.displays = ["LS32A600U", "LS32A600U"]
        XCTAssertThrowsError(try ScreenSharingUI.displayButton("LS32A600U", in: XCTUnwrap(ax.read().picker())))
        // Even an exact description with a non-button role is ineligible.
        let decoy = ScreenSharingNode(role: "AXStaticText", description: "Share LS32A600U")
        XCTAssertNil(try ScreenSharingUI.displayButton("LS32A600U", in: decoy))
    }

    func testPanelIdentityUsesExactNormalizedPrefixAndDoesNotConfuseTabOrDiscord() throws {
        let ax = SharingAX(); ax.panelOpen = true
        let panel = try XCTUnwrap(ax.read().panel())
        XCTAssertTrue(try ScreenSharingUI.verifyIdentity("  WILLIAM   BERGH  ", in: panel))
        XCTAssertThrowsError(try ScreenSharingUI.verifyIdentity("William", in: panel))
        XCTAssertThrowsError(try ScreenSharingUI.verifyIdentity("Somebody Else", in: panel))
        ax.faceTimeSelected = false
        XCTAssertFalse(try ScreenSharingUI.verifyIdentity("William Bergh", in: XCTUnwrap(ax.read().panel())))
        var duplicate = panel
        duplicate.children.append(ScreenSharingNode(role: "AXButton", description: "William Bergh, FaceTime Audio"))
        XCTAssertThrowsError(try ScreenSharingUI.verifyIdentity("William Bergh", in: duplicate))
    }

    func testShareStagesSelectFaceTimeAndExactDisplayThenDisableDefaultOnControl() throws {
        let h = SharingHarness(); h.ax.faceTimeSelected = false
        try h.execute(display: "BenQ GL2460 (2)")
        XCTAssertTrue(h.ax.presses.isEmpty, "No synchronous ingress mutations")
        h.clock.drain()
        XCTAssertNil(h.error)
        XCTAssertEqual(h.ax.presses, ["com.apple.menuextra.audiovideo", "FaceTime", "facetime-share-toggle", "Share BenQ GL2460 (2)", "com.apple.menuextra.audiovideo", "allow-remote-control-toggle"])
        XCTAssertEqual(h.result?["active"] as? Bool, true)
        XCTAssertEqual(h.result?["display"] as? String, "BenQ GL2460 (2)")
        XCTAssertEqual(h.result?["remoteControl"] as? Bool, false)
        XCTAssertEqual(h.result?["verified"] as? Bool, true)
        XCTAssertEqual(h.ax.remote, "0")
        XCTAssertLessThan(h.clock.time, 5)
        try h.execute("screen.status")
        XCTAssertNil(h.result?["display"], "Status must not report a cached display after an unobservable manual switch")
    }

    func testSharingSurvivesSlowPanelAnimationsWithoutPrematureSafetyStop() throws {
        let h = SharingHarness()
        h.verificationTimeout = 12
        h.cleanupTimeout = 3
        h.ax.beforePress = { node in
            if node.handle == 1 {
                // Opening/reopening Control Center is asynchronous in macOS;
                // both transitions can exceed the old 2.7-second total budget.
                h.clock.schedule(0) { h.ax.panelOpen = false }
                h.clock.schedule(3.2) { h.ax.panelOpen = true }
            }
        }
        try h.execute(); h.clock.drain()
        XCTAssertNil(h.error)
        XCTAssertEqual(h.result?["verified"] as? Bool, true)
        XCTAssertTrue(h.ax.active)
        XCTAssertFalse(h.ax.presses.contains("Stop Sharing"))
        XCTAssertEqual(h.ax.presses.filter { $0 == "com.apple.menuextra.audiovideo" }.count, 2)
        XCTAssertEqual(h.ax.presses.filter { $0 == "Share LS32A600U" }.count, 1)
        XCTAssertGreaterThan(h.clock.time, 6)
        XCTAssertLessThan(h.clock.time, 12)
    }

    func testTimeoutReportsPhaseAndSafeEvidenceInsteadOfAnOpaqueMessage() throws {
        let h = SharingHarness(); h.ax.applyControlOff = false
        try h.execute(); h.clock.drain()
        XCTAssertTrue(h.error?.message.contains("at controlOff") == true)
        XCTAssertTrue(h.error?.message.contains("control=on") == true)
        XCTAssertTrue(h.error?.message.contains("attempted:") == true)
    }

    func testAlreadyOpenPanelIsNotToggledAndControlAlreadyOffIsNeverEnabled() throws {
        let h = SharingHarness(); h.ax.panelOpen = true
        h.ax.beforePress = { node in
            if node.handle >= 10 && node.handle < 20 {
                // Simulate the UI presenting an already-off control after selection.
                h.clock.schedule(0) { h.ax.remote = "0" }
            }
        }
        try h.execute(); h.clock.drain()
        XCTAssertNil(h.error)
        XCTAssertEqual(h.ax.presses.filter { $0 == "com.apple.menuextra.audiovideo" }.count, 1, "Only reopen after the picker")
        XCTAssertFalse(h.ax.presses.contains("FaceTime"))
        XCTAssertFalse(h.ax.presses.contains("allow-remote-control-toggle"))
    }

    func testRejectsExistingShareAndMismatchedIdentityWithoutMutations() throws {
        for mismatch in [false, true] {
            let h = SharingHarness(); h.ax.panelOpen = true
            h.ax.active = !mismatch
            if mismatch { h.ax.identity = "Someone Else" }
            try h.execute(); h.clock.drain()
            XCTAssertEqual(h.error?.code, mismatch ? "call_identity_mismatch" : "screen_already_active")
            XCTAssertTrue(h.ax.presses.isEmpty)
        }
    }

    func testPreexistingPickerCannotBeTakenOverEvenForTheExactDisplay() throws {
        for command in ["screen.share", "screen.stop"] {
            let h = SharingHarness(); h.ax.pickerOpen = true
            try h.execute(command); h.clock.drain()
            XCTAssertEqual(h.error?.code, "screen_picker_present")
            XCTAssertTrue(h.ax.presses.isEmpty)
        }
    }

    func testIngressRejectsUnverifiedDisconnectedMissingIdentityOrWrongCall() throws {
        let states = [
            ScreenSharingCall(id: "other", phase: "connected", verified: true, identity: "William Bergh"),
            ScreenSharingCall(id: "local-1", phase: "incoming", verified: true, identity: "William Bergh"),
            ScreenSharingCall(id: "local-1", phase: "connected", verified: false, identity: "William Bergh"),
            ScreenSharingCall(id: "local-1", phase: "connected", verified: true, identity: nil),
            ScreenSharingCall(id: "local-1", phase: "connected", verified: true, identity: ""),
            ScreenSharingCall(id: "local-1", phase: "connected", verified: true, identity: "William Bergh", present: false)
        ]
        for call in states {
            let h = SharingHarness(); h.call = call
            try h.execute()
            XCTAssertEqual(h.error?.code, "stale_call")
            XCTAssertEqual(h.ax.reads, 0)
            XCTAssertTrue(h.clock.pending.isEmpty)
        }
    }

    func testEveryDelayedStageRejectsChangedCallIDIdentityPhaseOrVerification() throws {
        for stage in 0...6 {
            for change in 0..<4 {
                let h = SharingHarness(); h.ax.faceTimeSelected = false
                try h.execute()
                for _ in 0..<stage { h.clock.step() }
                let previous = h.ax.presses
                switch change {
                case 0: h.call = ScreenSharingCall(id: "local-2", phase: "connected", verified: true, identity: "William Bergh")
                case 1: h.call = ScreenSharingCall(id: "local-1", phase: "connected", verified: true, identity: "Another Person")
                case 2: h.call = ScreenSharingCall(id: "local-1", phase: "idle", verified: true, identity: "William Bergh")
                default: h.call = ScreenSharingCall(id: "local-1", phase: "connected", verified: false, identity: "William Bergh")
                }
                h.clock.drain()
                XCTAssertEqual(h.ax.presses, previous, "Mutation after stale call at stage \(stage)")
                XCTAssertEqual(h.error?.code, "stale_call")
            }
        }
    }

    func testRechecksCallAfterReadImmediatelyBeforeMutation() throws {
        let h = SharingHarness(); h.ax.panelOpen = true
        h.ax.afterRead = { h.call = ScreenSharingCall(id: "local-2", phase: "connected", verified: true, identity: "William Bergh") }
        try h.execute(); h.clock.drain()
        XCTAssertEqual(h.error?.code, "stale_call")
        XCTAssertTrue(h.ax.presses.isEmpty)
    }

    func testRunInvalidatedDuringReadCannotMutate() throws {
        let h = SharingHarness(); h.ax.panelOpen = true
        h.ax.afterRead = { h.run.stop() }
        try h.execute(); h.clock.drain()
        XCTAssertTrue(h.ax.presses.isEmpty)
        XCTAssertTrue(h.results.isEmpty)
    }

    func testSerializesMutationsByRejectingBusyRequestsAndStatusRemainsReadOnly() throws {
        let h = SharingHarness()
        try h.execute(); try h.execute("screen.stop")
        XCTAssertEqual(h.error?.code, "screen_busy")
        try h.execute("screen.status")
        XCTAssertEqual(h.result?["verified"] as? Bool, false)
        XCTAssertTrue(h.ax.presses.isEmpty)
        h.clock.drain()
        XCTAssertEqual(h.results.count, 3)
        XCTAssertNil(h.error)
        XCTAssertEqual(h.result?["active"] as? Bool, true)
    }

    func testStopAndInvalidatePermanentlyCancelDelayedActions() throws {
        for stage in 0...6 {
            let h = SharingHarness(); h.ax.faceTimeSelected = false
            try h.execute()
            for _ in 0..<stage { h.clock.step() }
            let presses = h.ax.presses
            h.run.stop(); h.controller.invalidate()
            h.clock.drain()
            XCTAssertEqual(h.ax.presses, presses)
            XCTAssertTrue(h.results.isEmpty)
        }
        let h = SharingHarness(); h.controller.invalidate()
        try h.execute()
        XCTAssertEqual(h.error?.code, "service_stopped")
    }

    func testPollingDoesNotRetryPanelOrTabMutation() throws {
        for brokenTab in [false, true] {
            let h = SharingHarness()
            if brokenTab { h.ax.panelOpen = true; h.ax.faceTimeSelected = false; h.ax.tabWorks = false }
            else { h.ax.openWorks = false }
            try h.execute(); h.clock.drain()
            XCTAssertEqual(h.error?.code, "screen_timeout")
            XCTAssertEqual(h.ax.presses, [brokenTab ? "FaceTime" : "com.apple.menuextra.audiovideo"])
            XCTAssertLessThan(h.clock.time, 5)
        }
    }

    func testFailedViewOnlyEstablishmentDisablesOnlyOnceThenSafetyStopsOnce() throws {
        for missingControl in [false, true] {
            let h = SharingHarness(); h.ax.applyControlOff = false; h.ax.showRemote = !missingControl
            try h.execute(); h.clock.drain()
            XCTAssertEqual(h.error?.code, "screen_timeout")
            XCTAssertEqual(h.ax.presses.filter { $0 == "allow-remote-control-toggle" }.count, missingControl ? 0 : 1)
            XCTAssertEqual(h.ax.presses.filter { $0 == "Stop Sharing" }.count, 1)
            XCTAssertFalse(h.ax.active)
            XCTAssertTrue(h.error?.message.contains("sharing verified stopped") == true)
            XCTAssertLessThan(h.clock.time, 5)
        }
    }

    func testCleanupRetriesOnlyTransientReadsAndNeverRepeatsFailedPanelPress() throws {
        let h = SharingHarness(); h.ax.applyControlOff = false
        var transient = 0
        h.ax.readError = {
            if h.clock.time >= 2.7, transient < 2 {
                transient += 1
                return ScreenSharingError(code: "screen_ui_unavailable", message: "Animating")
            }
            return nil
        }
        try h.execute(); h.clock.drain()
        XCTAssertEqual(transient, 2)
        XCTAssertEqual(h.ax.presses.filter { $0 == "Stop Sharing" }.count, 1)
        XCTAssertFalse(h.ax.active)
        XCTAssertLessThan(h.clock.time, 5)

        let failedOpen = SharingHarness()
        failedOpen.ax.beforePress = { node in
            if node.handle == 1, failedOpen.ax.active {
                throw ScreenSharingError(code: "injected", message: "Panel press failed")
            }
        }
        try failedOpen.execute(); failedOpen.clock.drain()
        XCTAssertEqual(failedOpen.error?.code, "injected")
        XCTAssertEqual(failedOpen.ax.presses.filter { $0 == "com.apple.menuextra.audiovideo" }.count, 2, "Initial open plus one post-share open, not a retry during cleanup")
        XCTAssertFalse(failedOpen.ax.presses.contains("Stop Sharing"), "Cannot stop without an identity-verified panel")
        XCTAssertLessThan(failedOpen.clock.time, 5)
    }

    func testAXMutationErrorIsNeverRetriedAndStillAttemptsSafetyStop() throws {
        let h = SharingHarness()
        h.ax.beforePress = { node in
            if node.handle == 5 { throw ScreenSharingError(code: "injected", message: "Control press failed") }
        }
        try h.execute(); h.clock.drain()
        XCTAssertEqual(h.error?.code, "injected")
        XCTAssertEqual(h.ax.presses.filter { $0 == "allow-remote-control-toggle" }.count, 1)
        XCTAssertEqual(h.ax.presses.filter { $0 == "Stop Sharing" }.count, 1)
        XCTAssertFalse(h.ax.active)
    }

    func testUnsuccessfulSafetyStopIsNotRetriedOrReportedAsSuccess() throws {
        let h = SharingHarness(); h.ax.applyControlOff = false; h.ax.applyStop = false
        try h.execute(); h.clock.drain()
        XCTAssertEqual(h.error?.code, "screen_timeout")
        XCTAssertEqual(h.ax.presses.filter { $0 == "Stop Sharing" }.count, 1)
        XCTAssertTrue(h.ax.active)
        XCTAssertTrue(h.error?.message.contains("safety stop not verified") == true)
        XCTAssertLessThan(h.clock.time, 5)
    }

    func testMissingOrDuplicateExactDisplayNeverUsesGenericShareOrOtherDisplay() throws {
        for duplicate in [false, true] {
            let h = SharingHarness()
            h.ax.displays = duplicate ? ["LS32A600U", "LS32A600U"] : ["Other Display"]
            try h.execute(); h.clock.drain()
            XCTAssertNotNil(h.error)
            XCTAssertFalse(h.ax.presses.contains(where: { $0.hasPrefix("Share") }))
            XCTAssertEqual(h.ax.presses.filter { $0 == "facetime-share-toggle" }.count, 1)
            XCTAssertLessThan(h.clock.time, 5)
        }
    }

    func testStopUsesOnlyStopButtonAndVerifiesBothInactiveSignals() throws {
        let h = SharingHarness(); h.ax.panelOpen = true; h.ax.active = true
        try h.execute("screen.stop"); h.clock.drain()
        XCTAssertNil(h.error)
        XCTAssertEqual(h.ax.presses, ["Stop Sharing"])
        XCTAssertEqual(h.result?["active"] as? Bool, false)
        XCTAssertEqual(h.result?["verified"] as? Bool, true)
        XCTAssertFalse(h.ax.presses.contains("allow-remote-control-toggle"))
        let idle = SharingHarness(); idle.ax.panelOpen = true
        try idle.execute("screen.stop"); idle.clock.drain()
        XCTAssertTrue(idle.ax.presses.isEmpty)
        XCTAssertEqual(idle.result?["verified"] as? Bool, true)
    }

    func testStopMustNotReportSuccessWhileStillSharingOrRetryMutation() throws {
        let h = SharingHarness(); h.ax.active = true; h.ax.applyStop = false
        try h.execute("screen.stop"); h.clock.drain()
        XCTAssertEqual(h.error?.code, "screen_timeout")
        XCTAssertEqual(h.ax.presses.filter { $0 == "Stop Sharing" }.count, 1)
        XCTAssertFalse(h.ax.presses.contains("facetime-share-toggle"))
    }

    func testReadOnlyStatusNeverOpensPanelSelectsTabOrDisablesControl() throws {
        let h = SharingHarness()
        try h.execute("screen.status")
        XCTAssertEqual(h.result?["verified"] as? Bool, false)
        XCTAssertTrue(h.result?["active"] is NSNull)
        h.ax.panelOpen = true
        try h.execute("screen.status")
        XCTAssertEqual(h.result?["active"] as? Bool, false)
        XCTAssertEqual(h.result?["verified"] as? Bool, true)
        h.ax.active = true
        try h.execute("screen.status")
        XCTAssertEqual(h.result?["active"] as? Bool, true)
        XCTAssertEqual(h.result?["remoteControl"] as? Bool, true)
        XCTAssertEqual(h.result?["verified"] as? Bool, false, "Read-only status cannot establish view-only while control is ON")
        XCTAssertNil(h.result?["display"], "Do not infer display for an unowned existing share")
        h.ax.remote = "0"
        try h.execute("screen.status")
        XCTAssertEqual(h.result?["verified"] as? Bool, true)
        h.ax.showRemote = false
        try h.execute("screen.status")
        XCTAssertEqual(h.result?["verified"] as? Bool, false)
        h.ax.faceTimeSelected = false
        try h.execute("screen.status")
        XCTAssertEqual(h.result?["verified"] as? Bool, false)
        h.ax.faceTimeSelected = true; h.ax.identity = "Other Person"
        try h.execute("screen.status")
        XCTAssertEqual(h.result?["verified"] as? Bool, false)
        XCTAssertTrue(h.ax.presses.isEmpty)
    }

    func testActiveVerificationRequiresToggleAndCurrentlySharingAndControlOff() throws {
        let ax = SharingAX(); ax.panelOpen = true; ax.active = true
        XCTAssertEqual(try ScreenSharingUI.active(in: XCTUnwrap(ax.read().panel())), true)
        ax.showSharingText = false
        XCTAssertNil(try ScreenSharingUI.active(in: XCTUnwrap(ax.read().panel())))
        let h = SharingHarness(); h.ax.showSharingText = false
        try h.execute(); h.clock.drain()
        XCTAssertNotNil(h.error)
        XCTAssertFalse(h.ax.presses.contains("allow-remote-control-toggle"))
        XCTAssertEqual(h.ax.presses.filter { $0 == "Stop Sharing" }.count, 1)
    }

    func testStaleCallDuringSafetyCleanupCannotStopAnotherCall() throws {
        let h = SharingHarness(); h.ax.applyControlOff = false
        try h.execute()
        while h.clock.time < 2.7 { h.clock.step() }
        let presses = h.ax.presses
        h.call = ScreenSharingCall(id: "local-2", phase: "connected", verified: true, identity: "William Bergh")
        h.clock.drain()
        XCTAssertEqual(h.ax.presses, presses)
        XCTAssertNotNil(h.error)
        XCTAssertFalse(h.ax.presses.contains("Stop Sharing"))
    }
}
