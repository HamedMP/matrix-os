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
        .executableTarget(
            name: "MatrixSync",
            path: "Sources",
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
    ])
