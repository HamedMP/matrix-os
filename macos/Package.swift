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
        .library(name: "MatrixBoard", targets: ["MatrixBoard"]),
    ],
    dependencies: [
        // SwiftTerm: battle-tested VT100/xterm emulator used by the Terminal panel.
        // TODO(086): wire SwiftTerm into Sources/Terminal once the shell-WS client lands
        // (Phase 2/3). Resolution requires network access; if `swift build` is run fully
        // offline and this fails to resolve, temporarily comment this dependency and the
        // matching target dependency below — the rest of the package builds without it.
        .package(url: "https://github.com/migueldeicaza/SwiftTerm", from: "1.2.0"),
        // Native Swift code editor powered by tree-sitter.
        .package(url: "https://github.com/CodeEditApp/CodeEditSourceEditor", exact: "0.12.0"),
        // CodeEditSourceEditor 0.12.0 declares CodeEditTextView from 0.10.1, but
        // newer 0.12.x CodeEditTextView releases changed minimap APIs. Constrain
        // the resolver to the compatible release used by this source-editor tag.
        .package(url: "https://github.com/CodeEditApp/CodeEditTextView.git", exact: "0.10.1"),
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
            // Independent in Phase 2 (Foundation-only) so swarm agents build in isolation
            // via `swift build --target MatrixNet`. Integrated in the App/Board layer later.
            path: "Sources/Net",
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
        .target(
            name: "MatrixTerminal",
            dependencies: [
                "DesignSystem",
                // SwiftTerm-backed TerminalPanelView lands in US1 (T034).
                .product(name: "SwiftTerm", package: "SwiftTerm"),
            ],
            path: "Sources/Terminal",
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
        .target(
            name: "MatrixBoard",
            dependencies: ["MatrixNet", "MatrixModel"],
            path: "Sources/Board",
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
        .executableTarget(
            name: "MatrixOS",
            dependencies: [
                "DesignSystem",
                "MatrixModel",
                "MatrixNet",
                "MatrixTerminal",
                "MatrixBoard",
                .product(name: "CodeEditSourceEditor", package: "CodeEditSourceEditor"),
                .product(name: "CodeEditTextView", package: "CodeEditTextView"),
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
        .testTarget(
            name: "BoardTests",
            dependencies: ["MatrixBoard"],
            path: "Tests/BoardTests",
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
        .testTarget(
            name: "AppTests",
            dependencies: ["MatrixOS"],
            path: "Tests/AppTests",
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
    ]
)
