// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "MatrixOS",
    platforms: [
        .macOS(.v14),
    ],
    products: [
        .executable(name: "MatrixOS", targets: ["MatrixOS"]),
        .library(name: "DesignSystem", targets: ["DesignSystem"]),
    ],
    dependencies: [
        // SwiftTerm: battle-tested VT100/xterm emulator used by the Terminal panel.
        // TODO(086): wire SwiftTerm into Sources/Terminal once the shell-WS client lands
        // (Phase 2/3). Resolution requires network access; if `swift build` is run fully
        // offline and this fails to resolve, temporarily comment this dependency and the
        // matching target dependency below — the rest of the package builds without it.
        .package(url: "https://github.com/migueldeicaza/SwiftTerm", from: "1.2.0"),
    ],
    targets: [
        .target(
            name: "DesignSystem",
            path: "Sources/DesignSystem",
            swiftSettings: [
                .swiftLanguageMode(.v6),
            ]
        ),
        .executableTarget(
            name: "MatrixOS",
            dependencies: [
                "DesignSystem",
                // "SwiftTerm", // TODO(086): enable when Terminal panel is implemented.
            ],
            path: "Sources/App",
            swiftSettings: [
                .swiftLanguageMode(.v6),
            ]
        ),
        .testTarget(
            name: "DesignSystemTests",
            dependencies: ["DesignSystem"],
            path: "Tests/DesignSystemTests",
            swiftSettings: [
                .swiftLanguageMode(.v6),
            ]
        ),
    ]
)
