// Main-thread lifetime token. A fresh token is used for each service start;
// stopping permanently invalidates queued work, even after a later restart.
final class ServiceRun {
    private(set) var isRunning = true

    func stop() { isRunning = false }

    func perform(_ action: () -> Void) {
        guard isRunning else { return }
        action()
    }
}
