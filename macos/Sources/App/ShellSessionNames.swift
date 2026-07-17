import Foundation

private let shellSessionAdjectives = [
    "swift", "calm", "bright", "bold", "brave", "clever", "cosmic", "crisp",
    "amber", "azure", "lunar", "solar", "misty", "quiet", "rapid", "shiny",
    "still", "vivid", "warm", "wild", "noble", "lucid", "fresh", "keen",
    "neat", "prime", "spry", "deft", "mellow", "nimble", "sleek", "stark",
]

private let shellSessionNouns = [
    "falcon", "otter", "cedar", "river", "comet", "harbor", "meadow", "summit",
    "willow", "pine", "lynx", "heron", "maple", "delta", "ember", "quartz",
    "raven", "sparrow", "tide", "vale", "wren", "birch", "cobalt", "drift",
    "fern", "grove", "isle", "moss", "reef", "dune", "fjord", "atlas",
]

func generatedShellSessionName(collisionFallback: Bool = false) -> String {
    let adjective = shellSessionAdjectives.randomElement() ?? "swift"
    let noun = shellSessionNouns.randomElement() ?? "falcon"
    let base = "\(adjective)-\(noun)"
    guard collisionFallback else { return base }
    let suffix = UUID().uuidString
        .lowercased()
        .replacingOccurrences(of: "-", with: "")
        .prefix(5)
    return "\(base)-\(suffix)"
}
