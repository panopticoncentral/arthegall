import Foundation

@main
@MainActor
struct MacReportingProbe {
    struct Fixture: Decodable {
        let origin: String
        let code: String
        let fixtureURL: URL
    }

    static func main() async throws {
        try check(Bundle.main.bundleIdentifier?.hasPrefix("org.arthegall.fixture.") == true, "isolated bundle")
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])))
        let phase = CommandLine.arguments[2]
        let model = ConversationModel()
        if phase == "schedule" { await model.pair(address: fixture.origin, code: fixture.code) }
        try check(model.pairing != nil, model.problem ?? "pairing")
        let follower = Task { await model.follow() }
        defer { follower.cancel() }
        try await wait("snapshot") { model.online }

        switch phase {
        case "schedule":
            let admin = try value(model.snapshot?.conversations.first { $0.administrator == 1 }?.id, "Administrator DM")
            model.select(admin)
            model.edit("Create Rowan and run a usage report.", in: admin)
            await model.send()
            try await wait("usage access request") { model.snapshot?.grants.contains { $0.name == "Rowan" } == true }
            let grant = try value(model.snapshot?.grants.first { $0.name == "Rowan" }, "Rowan access")
            try check(grant.runnerId != nil && grant.assignmentId != nil, "access scope")
            let access = await model.saveSetting("access/" + grant.id, ["decision": "accept", "duration": "assignment"])
            try check(access, "assignment access approved")
            try await wait("on-demand report") { report(model, "2020-06-13")?.evidence?.codex.total == 33 }
            model.select(grant.conversationId)
            model.edit("Schedule a daily report at 8:00 AM Pacific.", in: grant.conversationId)
            await model.send()
            try await wait("scheduled item") { model.snapshot?.schedules.contains { $0.conversationId == grant.conversationId } == true }
        case "reply":
            let first = try value(report(model, "2020-06-14"), "first offline report")
            try check(first.text == "Synthetic total: 34", "original report text")
            try check(first.evidence?.codex.cachedInput == 0 && first.evidence?.claude.input == nil &&
                      first.evidence?.claude.coverage == "no_records", "recorded zero and unknown count")
            model.select(first.conversationId)
            model.reply(to: first, in: first.conversationId)
            model.edit("Put source coverage first from now on.", in: first.conversationId)
            await model.send()
            try check(model.local.pending?.replyTo == first.id && model.problem != nil, "reply target saved before acknowledgment")
        case "retry":
            let first = try value(report(model, "2020-06-14"), "first report after relaunch")
            try check(model.local.pending?.replyTo == first.id, "reply target restored across process launch")
            await model.send()
            try check(model.local.pending == nil && model.local.replyTargets?[first.conversationId] == nil, "reply acknowledged")
            try await wait("preference saved") {
                model.snapshot?.messages.contains { $0.text == "Saved your preference for the report with 34 tokens." } == true
            }
        case "verify":
            let first = try value(report(model, "2020-06-14"), "preserved first report")
            let next = try value(report(model, "2020-06-15"), "second offline report")
            try check(first.evidence?.codex.total == 34 && next.evidence?.codex.total == 35, "distinct saved evidence")
            try check(next.text.hasPrefix("Source coverage: local records."), "next report leads with coverage")
            await model.unpair()
            try check(model.pairing == nil, "fixture pairing removed")
        default: throw ClientError(message: "Unknown reporting phase")
        }
        print("Mac reporting phase passed: \(phase)")
    }

    private static func report(_ model: ConversationModel, _ day: String) -> Message? {
        model.snapshot?.messages.first { $0.evidence?.range.start == day }
    }

    private static func value<T>(_ value: T?, _ description: String) throws -> T {
        guard let value else { throw ClientError(message: "Missing \(description)") }
        return value
    }

    private static func check(_ passed: Bool, _ description: String) throws {
        if !passed { throw ClientError(message: "Failed: \(description)") }
    }

    private static func wait(_ description: String, _ predicate: () -> Bool) async throws {
        for _ in 0..<200 {
            if predicate() { return }
            try await Task.sleep(for: .milliseconds(100))
        }
        throw ClientError(message: "Timed out: \(description)")
    }
}
