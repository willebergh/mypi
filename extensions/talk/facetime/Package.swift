// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "FaceTimeObserver",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "facetime-observer", targets: ["FaceTimeObserver"])
    ],
    targets: [
        .executableTarget(name: "FaceTimeObserver"),
        .testTarget(name: "FaceTimeObserverTests", dependencies: ["FaceTimeObserver"])
    ],
    swiftLanguageModes: [.v5]
)
