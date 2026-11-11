// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "MatrixSync",
    platforms: [
        .macOS(.v14),
    ],
    products: [
        .executable(name: "MatrixSync", targets: ["MatrixSync"]),
    ],
    targets: [
        .target(
            name: "MatrixSyncSupport",
            path: "Sources/MatrixSyncSupport"),
        .executableTarget(
            name: "MatrixSync",
            dependencies: ["MatrixSyncSupport"],
            path: "Sources",
            exclude: ["MatrixSyncSupport"],
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .testTarget(
            name: "MatrixSyncTests",
            dependencies: ["MatrixSyncSupport"],
            path: "Tests"),
    ])
