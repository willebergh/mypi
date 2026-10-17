import AppKit
import Foundation

let bridgeApplicationName = "Pi FaceTime Bridge"
let bridgeBundleIdentifier = "dev.mypi.facetime-bridge"
let bridgeExecutableName = "facetime-observer"

// Pure entry-point selection: never infer app mode from a binary's filename,
// cwd, or a parent directory alone. Explicit CLI arguments retain CLI behavior.
func usesBridgeApplicationEntry(arguments: [String], bundleIdentifier: String?, bundlePath: String, bundleExecutable: String?) -> Bool {
    arguments.count == 1 &&
        bundleIdentifier == bridgeBundleIdentifier &&
        (bundlePath as NSString).pathExtension == "app" &&
        bundleExecutable == bridgeExecutableName
}

protocol BridgeService: AnyObject {
    func start() throws
    func stop()
}

extension WatchService: BridgeService {}

enum BridgeApplicationStatus: Equatable {
    case stopped
    case permissionNeeded
    case running
    case startupError(String)

    var title: String {
        switch self {
        case .stopped: return "Service stopped"
        case .permissionNeeded: return "Accessibility permission needed"
        case .running: return "Service running"
        case .startupError: return "Startup error"
        }
    }

    var message: String? {
        switch self {
        case .permissionNeeded:
            return "Enable Pi FaceTime Bridge in System Settings > Privacy & Security > Accessibility, then choose Start service. Permission is only requested when you choose Request Accessibility permission."
        case .startupError(let message): return message
        default: return nil
        }
    }
}

// Main-thread controller, separated from AppKit so lifecycle/permission policy
// can be tested without creating NSApplication or accessing Accessibility.
final class BridgeApplicationController {
    private let loadOptions: () -> Options
    private let isTrusted: () -> Bool
    private let promptForPermission: () -> Void
    private let makeService: (Options) -> BridgeService
    private var service: BridgeService?
    private(set) var status = BridgeApplicationStatus.stopped {
        didSet { onChange?() }
    }
    var onChange: (() -> Void)?

    init(loadOptions: @escaping () -> Options,
         isTrusted: @escaping () -> Bool,
         promptForPermission: @escaping () -> Void,
         makeService: @escaping (Options) -> BridgeService) {
        self.loadOptions = loadOptions
        self.isTrusted = isTrusted
        self.promptForPermission = promptForPermission
        self.makeService = makeService
    }

    func start() {
        guard service == nil else { return }
        // Reload on every explicit retry, allowing config repair without quit.
        let options = loadOptions()
        if let error = options.configError {
            let path = NSString(string: options.configPath).expandingTildeInPath
            status = .startupError("Could not load config at \(path): \(error)\nFix this file, then choose Retry.")
            return
        }
        guard isTrusted() else {
            status = .permissionNeeded
            return
        }
        let candidate = makeService(options)
        do {
            try candidate.start()
            service = candidate
            status = .running
        } catch {
            candidate.stop()
            status = .startupError("Could not start service: \(error.localizedDescription)\nCheck the configured socket path and whether another service is running, then choose Retry.")
        }
    }

    func stop() {
        service?.stop()
        service = nil
        status = .stopped
    }

    func requestPermission() {
        promptForPermission()
        refreshPermission()
    }

    func refreshPermission() {
        // No polling, prompts, or automatic restarts after permission changes.
        if status == .permissionNeeded && isTrusted() { status = .stopped }
    }
}

private final class BridgeApplicationDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private let controller: BridgeApplicationController
    private var statusItem: NSStatusItem?
    private let menu = NSMenu()

    init(arguments: [String]) {
        controller = BridgeApplicationController(
            loadOptions: {
                Options(arguments: arguments, persistedConfigPath: UserDefaults.standard.string(forKey: talkConfigPathDefaultsKey))
            },
            isTrusted: { accessibilityTrusted(prompt: false) },
            promptForPermission: { _ = accessibilityTrusted(prompt: true) },
            makeService: { WatchService(options: $0, emitStdout: false) }
        )
        super.init()
        menu.autoenablesItems = false
        controller.onChange = { [weak self] in self?.updateMenu() }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let image = NSImage(systemSymbolName: "phone.fill", accessibilityDescription: bridgeApplicationName) {
            image.isTemplate = true
            item.button?.image = image
        } else {
            item.button?.title = "Pi"
        }
        item.menu = menu
        statusItem = item
        menu.delegate = self
        updateMenu()
        // An explicit user launch is sufficient only when already trusted.
        controller.start()
    }

    func applicationWillTerminate(_ notification: Notification) { controller.stop() }

    func menuWillOpen(_ menu: NSMenu) {
        controller.refreshPermission()
        updateMenu()
    }

    private func updateMenu() {
        menu.removeAllItems()
        let heading = menu.addItem(withTitle: bridgeApplicationName, action: nil, keyEquivalent: "")
        heading.isEnabled = false
        let status = menu.addItem(withTitle: controller.status.title, action: nil, keyEquivalent: "")
        status.isEnabled = false
        statusItem?.button?.toolTip = "\(bridgeApplicationName): \(controller.status.title)"
        if let message = controller.status.message {
            let detail = NSMenuItem()
            let text = NSTextField(wrappingLabelWithString: message)
            text.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
            text.frame = NSRect(x: 12, y: 8, width: 320, height: 0)
            text.preferredMaxLayoutWidth = 320
            text.sizeToFit()
            let view = NSView(frame: NSRect(x: 0, y: 0, width: 344, height: text.frame.height + 16))
            view.addSubview(text)
            detail.view = view
            menu.addItem(detail)
        }
        menu.addItem(.separator())
        let retry: Bool
        if case .startupError = controller.status { retry = true } else { retry = false }
        addAction(retry ? "Retry" : "Start service", #selector(startService), enabled: controller.status != .running)
        addAction("Stop service (doesn't hang up)", #selector(stopService), enabled: controller.status == .running)
        menu.addItem(.separator())
        addAction("Choose Talk config…", #selector(chooseTalkConfig))
        addAction("Reset to default Talk config", #selector(resetTalkConfig))
        menu.addItem(.separator())
        addAction("Open Accessibility settings", #selector(openAccessibilitySettings))
        addAction("Request Accessibility permission", #selector(requestPermission))
        menu.addItem(.separator())
        addAction("Quit", #selector(quit), key: "q")
    }

    private func addAction(_ title: String, _ action: Selector, enabled: Bool = true, key: String = "") {
        let item = menu.addItem(withTitle: title, action: action, keyEquivalent: key)
        item.target = self
        item.isEnabled = enabled
    }

    @objc private func startService() { controller.start() }
    @objc private func stopService() { controller.stop() }
    @objc private func chooseTalkConfig() {
        // A user action grants file selection; persist only its absolute path.
        // The running service deliberately keeps its current file and routes.
        let panel = NSOpenPanel()
        panel.title = "Choose Talk config"
        panel.message = "Select talk.json. Takes effect on the next Stop/Start or Retry; an explicit --config still wins."
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        if panel.runModal() == .OK, let url = panel.url {
            UserDefaults.standard.set(url.standardizedFileURL.path, forKey: talkConfigPathDefaultsKey)
        }
    }
    @objc private func resetTalkConfig() {
        // Like choosing a file, this never changes a running service.
        UserDefaults.standard.removeObject(forKey: talkConfigPathDefaultsKey)
    }
    @objc private func requestPermission() { controller.requestPermission() }
    @objc private func openAccessibilitySettings() {
        // Only this user action opens Settings; startup never launches an app.
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility") {
            NSWorkspace.shared.open(url)
        }
    }
    @objc private func quit() {
        controller.stop()
        NSApplication.shared.terminate(nil)
    }
}

func runBridgeApplication(arguments: [String]) -> Never {
    let application = NSApplication.shared
    application.setActivationPolicy(.accessory)
    let delegate = BridgeApplicationDelegate(arguments: arguments)
    application.delegate = delegate
    withExtendedLifetime(delegate) { application.run() }
    exit(0)
}
