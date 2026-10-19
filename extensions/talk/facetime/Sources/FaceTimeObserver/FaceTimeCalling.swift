import AppKit
import Foundation

enum FaceTimeCallMedia: String {
    case audio, video

    /// Only absence defaults to audio: null, wrong types and unknown values fail closed.
    static func fromCommand(_ command: [String: Any]) throws -> FaceTimeCallMedia {
        guard Set(command.keys).isSubset(of: ["type", "command", "id", "to", "media"]) else {
            throw FaceTimeCallRequestError(code: "invalid_command", message: "Unknown call command argument")
        }
        guard let value = command["media"] else { return .audio }
        guard let text = value as? String, let media = FaceTimeCallMedia(rawValue: text) else {
            throw FaceTimeCallRequestError(code: "invalid_media", message: "Call media must be audio or video; omit for audio")
        }
        return media
    }
}

struct FaceTimeCallRequestError: LocalizedError {
    let code: String
    let message: String
    var errorDescription: String? { message }
}

func faceTimeCallURL(to recipient: String, media: FaceTimeCallMedia = .audio) -> URL? {
    let allowed = CharacterSet.urlHostAllowed.subtracting(CharacterSet(charactersIn: "/?#"))
    guard let encoded = recipient.addingPercentEncoding(withAllowedCharacters: allowed) else { return nil }
    // Apple documents facetime:// for native video calls:
    // https://developer.apple.com/library/archive/featuredarticles/iPhoneURLScheme_Reference/FacetimeLinks/FacetimeLinks.html
    // Keep the existing macOS audio scheme; never fall back between media.
    let scheme = media == .video ? "facetime" : "facetime-audio"
    return URL(string: "\(scheme)://\(encoded)")
}

func initiateFaceTimeCall(to recipient: String, media: FaceTimeCallMedia = .audio, completion: @escaping (Result<Void, Error>) -> Void) {
    guard let callURL = faceTimeCallURL(to: recipient, media: media) else {
        completion(.failure(NSError(domain: "FaceTimeObserver", code: 20, userInfo: [NSLocalizedDescriptionKey: "Recipient cannot be encoded as a FaceTime URL"])))
        return
    }

    let appURL = URL(fileURLWithPath: "/System/Applications/FaceTime.app")
    let configuration = NSWorkspace.OpenConfiguration()
    configuration.activates = true
    configuration.addsToRecentItems = false
    NSWorkspace.shared.open([callURL], withApplicationAt: appURL, configuration: configuration) { _, error in
        if let error { completion(.failure(error)) }
        else { completion(.success(())) }
    }
}
