import Foundation
import ApplicationServices

func timestamp() -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.string(from: Date())
}

func jsonData(_ object: Any, pretty: Bool = false) throws -> Data {
    try JSONSerialization.data(withJSONObject: object, options: pretty ? [.prettyPrinted, .sortedKeys] : [.sortedKeys])
}

func jsonLine(_ object: Any) -> Data {
    var data = (try? jsonData(object)) ?? Data("{\"type\":\"error\",\"error\":\"JSON encoding failed\"}".utf8)
    data.append(0x0a)
    return data
}

func jsonString(_ object: Any, pretty: Bool = false) -> String {
    String(data: (try? jsonData(object, pretty: pretty)) ?? Data(), encoding: .utf8) ?? "{}"
}

func axErrorName(_ error: AXError) -> String {
    switch error {
    case .success: return "success"
    case .failure: return "failure"
    case .illegalArgument: return "illegalArgument"
    case .invalidUIElement: return "invalidUIElement"
    case .invalidUIElementObserver: return "invalidUIElementObserver"
    case .cannotComplete: return "cannotComplete"
    case .attributeUnsupported: return "attributeUnsupported"
    case .actionUnsupported: return "actionUnsupported"
    case .notificationUnsupported: return "notificationUnsupported"
    case .notImplemented: return "notImplemented"
    case .notificationAlreadyRegistered: return "notificationAlreadyRegistered"
    case .notificationNotRegistered: return "notificationNotRegistered"
    case .apiDisabled: return "apiDisabled"
    case .noValue: return "noValue"
    case .parameterizedAttributeUnsupported: return "parameterizedAttributeUnsupported"
    case .notEnoughPrecision: return "notEnoughPrecision"
    @unknown default: return "unknown(\(error.rawValue))"
    }
}

func axValueDescription(_ value: Any) -> Any {
    if let string = value as? String { return string }
    if let number = value as? NSNumber { return number }
    if let url = value as? URL { return url.absoluteString }
    if let array = value as? [Any] { return array.map(axValueDescription) }
    if CFGetTypeID(value as CFTypeRef) == AXValueGetTypeID() {
        let axValue = unsafeBitCast(value as AnyObject, to: AXValue.self)
        switch AXValueGetType(axValue) {
        case .cgPoint:
            var point = CGPoint.zero
            AXValueGetValue(axValue, .cgPoint, &point)
            return ["x": point.x, "y": point.y]
        case .cgSize:
            var size = CGSize.zero
            AXValueGetValue(axValue, .cgSize, &size)
            return ["width": size.width, "height": size.height]
        case .cgRect:
            var rect = CGRect.zero
            AXValueGetValue(axValue, .cgRect, &rect)
            return ["x": rect.origin.x, "y": rect.origin.y, "width": rect.width, "height": rect.height]
        case .cfRange:
            var range = CFRange()
            AXValueGetValue(axValue, .cfRange, &range)
            return ["location": range.location, "length": range.length]
        case .axError:
            var error = AXError.success
            AXValueGetValue(axValue, .axError, &error)
            return axErrorName(error)
        case .illegal:
            return "<illegal AXValue>"
        @unknown default:
            return "<unknown AXValue>"
        }
    }
    if CFGetTypeID(value as CFTypeRef) == AXUIElementGetTypeID() { return "<AXUIElement>" }
    return String(describing: value)
}
