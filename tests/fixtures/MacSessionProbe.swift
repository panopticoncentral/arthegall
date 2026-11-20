import Foundation

@main
struct MacSessionProbe {
    struct Fixture: Decodable { var origin: String; var code: String }
    @MainActor
    static func main() async throws {
        let url = URL(fileURLWithPath: CommandLine.arguments[1])
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
        let phase = CommandLine.arguments[2]
        try require(Bundle.main.bundleIdentifier?.hasPrefix("org.arthegall.fixture.") == true)
        let model = ConversationModel()
        if phase == "pair" {
            try require(model.pairing == nil)
            await model.pair(address: fixture.origin, code: fixture.code)
        }
        guard model.pairing != nil else { throw ClientError(message: model.problem ?? "Missing test pairing") }
        let follower = Task { await model.follow() }
        defer { follower.cancel() }
        try await wait { model.online && model.selected != nil }
        switch phase {
        case "pair":
            model.edit("/test approval", in: model.selected!)
            await model.send()
            try require(model.local.pending != nil && model.problem != nil)
            try await wait { model.snapshot?.messages.contains(where: { $0.text == "Synthetic response in progress…" }) == true }
            print("Native model paired, saw streamed progress, retained uncertain command.")
        case "retry":
            try require(model.local.pending != nil)
            await model.send()
            try require(model.local.pending == nil)
            print("New process recovered Keychain session and retried saved command.")
        case "finish":
            try require(model.snapshot?.messages.contains(where: { $0.text.hasPrefix("Synthetic approval declined.") }) == true)
            try require(model.snapshot?.messages.filter { $0.author == "user" }.count == 1)
            await model.unpair()
            try require(model.pairing == nil)
            print("New process found offline completion and revoked pairing.")
        default: throw ClientError(message: "Unknown test phase")
        }
    }
    static func require(_ success: Bool) throws {
        if !success { throw ClientError(message: "Native session assertion failed") }
    }
    @MainActor static func wait(_ check: () -> Bool) async throws {
        for _ in 0..<100 {
            if check() { return }
            try await Task.sleep(for: .milliseconds(100))
        }
        throw ClientError(message: "Native session timed out")
    }
}
