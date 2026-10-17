import AppKit
import Foundation

func initiateFaceTimeAudioCall(to recipient: String, completion: @escaping (Result<Void, Error>) -> Void) {
    let allowed = CharacterSet.urlHostAllowed.subtracting(CharacterSet(charactersIn: "/?#"))
    guard let encoded = recipient.addingPercentEncoding(withAllowedCharacters: allowed),
          let callURL = URL(string: "facetime-audio://\(encoded)") else {
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
