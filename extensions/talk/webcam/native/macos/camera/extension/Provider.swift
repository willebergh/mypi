import Foundation
import CoreMedia
import CoreMediaIO
import IOKit.audio
import os

private let cameraLogger = Logger(subsystem: "PiTalkWebcam.CameraExtension", category: "Provider")

enum CameraIdentity {
    // Fixed, distinct identities. Never generate new UUIDs during discovery or startup.
    static let deviceID = UUID(uuidString: "71CBB0D9-7FE0-4C8F-91CA-4A9B43D64FD3")!
    static let streamID = UUID(uuidString: "46833C22-78B0-4C18-B44C-9BA17F250C2D")!
    static let localizedName = "Pi Talk Webcam"
}

final class PiTalkProviderSource: NSObject, CMIOExtensionProviderSource {
    private(set) var provider: CMIOExtensionProvider!
    private var deviceSource: PiTalkDeviceSource!

    /// Throw initialization errors to main instead of advertising a partly initialized device.
    init(clientQueue: DispatchQueue?) throws {
        super.init()
        let source = try PiTalkDeviceSource.make()
        let provider = CMIOExtensionProvider(source: self, clientQueue: clientQueue)
        try provider.addDevice(source.device)
        self.deviceSource = source // CMIO's source references are weak; retain every source.
        self.provider = provider
        cameraLogger.notice("Provider configured: Pi Talk Webcam")
    }

    var availableProperties: Set<CMIOExtensionProperty> { [.providerManufacturer] }

    func providerProperties(forProperties properties: Set<CMIOExtensionProperty>) throws -> CMIOExtensionProviderProperties {
        let result = CMIOExtensionProviderProperties(dictionary: [:])
        if properties.contains(.providerManufacturer) { result.manufacturer = "Pi Talk" }
        return result
    }

    func setProviderProperties(_ providerProperties: CMIOExtensionProviderProperties) throws {}

    func connect(to client: CMIOExtensionClient) throws {
        cameraLogger.debug("Client connected")
    }

    func disconnect(from client: CMIOExtensionClient) {
        // CMIO balances stream start/stop callbacks. A provider disconnect must NOT
        // decrement demand: that would double-stop or interrupt other streaming clients.
        cameraLogger.debug("Client disconnected")
    }

    func shutdown() { deviceSource?.shutdown() }
}

final class PiTalkDeviceSource: NSObject, CMIOExtensionDeviceSource {
    private(set) var device: CMIOExtensionDevice!
    private var streamSource: PiTalkStreamSource!
    private var pump: FramePump!

    private init(pattern: TestPattern) throws {
        super.init()
        device = CMIOExtensionDevice(localizedName: CameraIdentity.localizedName,
                                     deviceID: CameraIdentity.deviceID,
                                     legacyDeviceID: nil, source: self)
        let format = CMIOExtensionStreamFormat(
            formatDescription: pattern.formatDescription,
            maxFrameDuration: CameraVideo.frameDuration,
            minFrameDuration: CameraVideo.frameDuration, validFrameDurations: nil)
        streamSource = PiTalkStreamSource(deviceSource: self, format: format)
        try device.addStream(streamSource.stream)
        pump = FramePump(pattern: pattern) { [weak stream = streamSource.stream] frame, boundary in
            let flags: CMIOExtensionStream.DiscontinuityFlags
            switch boundary {
            case .none: flags = []
            case .restart: flags = [.time]
            case .sampleDropped: flags = [.sampleDropped]
            }
            stream?.send(frame.sampleBuffer, discontinuity: flags,
                         hostTimeInNanoseconds: frame.hostTimeInNanoseconds)
        }
    }

    static func make() throws -> PiTalkDeviceSource {
        try PiTalkDeviceSource(pattern: TestPattern())
    }

    var availableProperties: Set<CMIOExtensionProperty> { [.deviceTransportType, .deviceModel] }

    func deviceProperties(forProperties properties: Set<CMIOExtensionProperty>) throws -> CMIOExtensionDeviceProperties {
        let result = CMIOExtensionDeviceProperties(dictionary: [:])
        if properties.contains(.deviceTransportType) { result.transportType = kIOAudioDeviceTransportTypeVirtual }
        if properties.contains(.deviceModel) { result.model = "Pi Talk Webcam Test Pattern" }
        return result
    }

    func setDeviceProperties(_ deviceProperties: CMIOExtensionDeviceProperties) throws {}
    func startStreaming() throws { try pump.start() }
    func stopStreaming() { pump.stop() }
    func shutdown() { pump?.shutdown() }
}

final class PiTalkStreamSource: NSObject, CMIOExtensionStreamSource {
    private(set) var stream: CMIOExtensionStream!
    private weak var deviceSource: PiTalkDeviceSource?
    private let format: CMIOExtensionStreamFormat

    init(deviceSource: PiTalkDeviceSource, format: CMIOExtensionStreamFormat) {
        self.deviceSource = deviceSource
        self.format = format
        super.init()
        stream = CMIOExtensionStream(localizedName: "Pi Talk Webcam Video",
                                     streamID: CameraIdentity.streamID,
                                     direction: .source, clockType: .hostTime, source: self)
    }

    var formats: [CMIOExtensionStreamFormat] { [format] }
    var availableProperties: Set<CMIOExtensionProperty> { [.streamActiveFormatIndex, .streamFrameDuration] }

    func streamProperties(forProperties properties: Set<CMIOExtensionProperty>) throws -> CMIOExtensionStreamProperties {
        let result = CMIOExtensionStreamProperties(dictionary: [:])
        if properties.contains(.streamActiveFormatIndex) { result.activeFormatIndex = 0 }
        if properties.contains(.streamFrameDuration) { result.frameDuration = CameraVideo.frameDuration }
        return result
    }

    func setStreamProperties(_ streamProperties: CMIOExtensionStreamProperties) throws {
        if let index = streamProperties.activeFormatIndex, index != 0 {
            cameraLogger.error("Rejected unsupported format index: \(index)")
            throw CameraError.invalid("Only format index 0 (1280x720 BGRA) is supported")
        }
        if let duration = streamProperties.frameDuration,
           CMTimeCompare(duration, CameraVideo.frameDuration) != 0 {
            cameraLogger.error("Rejected unsupported frame duration")
            throw CameraError.invalid("Only frame duration 1/30 is supported")
        }
    }

    func authorizedToStartStream(for client: CMIOExtensionClient) -> Bool {
        // This authorizes consuming our synthetic output. Never request authorization
        // for, enumerate, or open a physical capture device.
        true
    }

    func startStream() throws {
        guard let deviceSource else { throw CameraError.invalid("Device source is unavailable") }
        try deviceSource.startStreaming()
    }

    func stopStream() throws { deviceSource?.stopStreaming() }
}
