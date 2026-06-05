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
        .library(name: "MatrixModel", targets: ["MatrixModel"]),
        .library(name: "MatrixNet", targets: ["MatrixNet"]),
        .library(name: "MatrixTerminal", targets: ["MatrixTerminal"]),
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
        // Foundational modules (Phase 2). Agents add files into these dirs WITHOUT
        // editing Package.swift, to avoid manifest contention in the swarm.
        .target(
            name: "MatrixModel",
            path: "Sources/Model",
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
        .target(
            name: "MatrixNet",
            dependencies: ["MatrixModel"],
            path: "Sources/Net",
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
        .target(
            name: "MatrixTerminal",
            dependencies: ["MatrixNet", "MatrixModel"],
            // SwiftTerm view lands in Phase 3 (T034); ShellWSClient (Phase 2) is pure URLSession.
            path: "Sources/Terminal",
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
        .executableTarget(
            name: "MatrixOS",
            dependencies: [
                "DesignSystem",
                "MatrixModel",
                "MatrixNet",
                "MatrixTerminal",
                // "SwiftTerm", // TODO(086): enable when Terminal panel view is implemented (T034).
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
        .testTarget(
            name: "ModelTests",
            dependencies: ["MatrixModel"],
            path: "Tests/ModelTests",
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
        .testTarget(
            name: "NetTests",
            dependencies: ["MatrixNet"],
            path: "Tests/NetTests",
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
        .testTarget(
            name: "TerminalTests",
            dependencies: ["MatrixTerminal"],
            path: "Tests/TerminalTests",
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
    ]
)
