// swift-tools-version:5.9
// DualSoundCore: lógica pura (protocolo de red, reloj, línea de tiempo y control
// de deriva). No depende de AVFoundation ni de Network, así que se prueba con
// `swift test` en macOS (o Linux) sin necesidad de un iPhone.
import PackageDescription

let package = Package(
    name: "DualSoundCore",
    platforms: [.iOS(.v16), .macOS(.v13)],
    products: [
        .library(name: "DualSoundCore", targets: ["DualSoundCore"]),
    ],
    targets: [
        .target(name: "DualSoundCore"),
        .testTarget(name: "DualSoundCoreTests", dependencies: ["DualSoundCore"]),
    ]
)
