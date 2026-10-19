import Foundation
import CoreMediaIO
import os

// @main (rather than top-level expressions) supports swiftc -parse-as-library.
// This executable is the bundle entry point, NOT a command-line camera test.
@main
struct CameraExtensionMain {
    static func main() {
        let logger = Logger(subsystem: "PiTalkWebcam.CameraExtension", category: "Lifecycle")
        do {
            let source = try PiTalkProviderSource(
                clientQueue: DispatchQueue(label: "PiTalkWebcam.clients"))
            // CMIO owns SIGTERM handling. Do not override it or call ignoreSIGTERM.
            CMIOExtensionProvider.startService(provider: source.provider)
            logger.notice("Camera extension service started")
            withExtendedLifetime(source) {
                CFRunLoopRun()
                source.shutdown()
            }
        } catch {
            logger.fault("Camera extension initialization failed: \(error.localizedDescription, privacy: .public)")
            exit(EXIT_FAILURE)
        }
    }
}
