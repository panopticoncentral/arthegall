import Foundation

@main
@MainActor
struct MacLiveProbe {
    private struct Fixture: Decodable {
        let origin: String
        let code: String
    }

    static func main() async throws {
        try require(Bundle.main.bundleIdentifier?.hasPrefix("org.arthegall.fixture.live-") == true, "Isolated app identity")
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])))
        let model = ConversationModel()
        let phase = CommandLine.arguments[2]
        if phase == "pair" { await model.pair(address: fixture.origin, code: fixture.code) }
        try require(model.pairing != nil, model.problem ?? "Expected an existing Mac pairing")
        let follower = Task { await model.follow() }
        defer { follower.cancel() }
        try await wait("the packaged server", model: model) { model.online }
        guard let admin = model.snapshot?.conversations.first(where: { $0.administrator == 1 }) else {
            throw ClientError(message: "Administrator DM unavailable")
        }

        if phase == "pair" {
            let prior = try await send("Remember the synthetic phrase cobalt meadow. Reply with just those two words and save the completed outcome.", in: admin.id, model: model)
            let reply = try await completed(in: admin.id, after: prior, model: model)
            try require(reply.text.localizedCaseInsensitiveContains("cobalt meadow"), "First live administrator reply")
            print("Verified native pairing and the first live administrator DM.")
        } else if phase == "continue" {
            let prior = try await send("What was the synthetic phrase? Reply with only those two words and save the completed outcome.", in: admin.id, model: model)
            let reply = try await completed(in: admin.id, after: prior, model: model)
            try require(reply.text.localizedCaseInsensitiveContains("cobalt meadow"), "Live administrator context preserved after restart")
            try await approveCommand(in: admin.id, allow: true, model: model)
            try await approveCommand(in: admin.id, allow: false, model: model)
            try await report(in: admin.id, model: model)
            await model.unpair()
            try require(model.pairing == nil, "Temporary Mac pairing should be removed")
        } else { throw ClientError(message: "Unknown live acceptance phase") }
    }

    private static func approveCommand(in dm: String, allow: Bool, model: ConversationModel) async throws {
        let prior = try await send("/test native approval", in: dm, model: model)
        try await wait("the exact diagnostic command approval", model: model) {
            model.snapshot?.approvals?.contains { $0.conversationId == dm } == true
        }
        guard let approval = model.snapshot?.approvals?.first(where: { $0.conversationId == dm }) else {
            throw ClientError(message: "Command approval is missing")
        }
        let command = "printf 'synthetic' > approval-note-\(approval.runId).txt\nScope: this run’s synthetic file in the assignment workspace."
        try require(approval.command == command, "Unexpected command or execution scope")
        await model.decideCommand(approval, allow: allow)
        _ = try await completed(in: dm, after: prior, model: model)
    }

    private static func report(in admin: String, model: ConversationModel) async throws {
        let setup = "Create a reporting agent named Rowan and an assignment to report local Codex and Claude usage. Request access and queue its report for June 15, 2020, now."
        _ = try await send(setup, in: admin, model: model)
        try await wait("the requested report and access grant", model: model) {
            model.snapshot?.grants.contains { grant in
                grant.name == "Rowan" && model.snapshot?.messages.contains { $0.conversationId == grant.conversationId && $0.requestedReport == 1 } == true
            } == true
        }
        guard let grant = model.snapshot?.grants.first(where: { $0.name == "Rowan" }), grant.runnerId != nil, grant.assignmentId != nil else {
            throw ClientError(message: "Missing reporting access scope")
        }
        model.select(grant.conversationId)
        let allowed = await model.saveSetting("access/" + grant.id, ["decision": "accept", "duration": "assignment"])
        try require(allowed, model.settingsError ?? "Unable to approve reporting access")
        let report = try await completed(in: grant.conversationId, after: nil, model: model)
        try require(report.text.contains("137") && report.evidence?.codex.total == 137 && report.evidence?.codex.cachedInput == 5 &&
                    report.evidence?.claude.coverage == "no_records" && report.evidence?.range.start == "2020-06-15",
                    "Unexpected synthetic usage or coverage")
        model.reply(to: report, in: grant.conversationId)
        let prior = try await send("How many cached input tokens did this report count? Reply with the number in digits.", in: grant.conversationId, model: model)
        let reply = try await completed(in: grant.conversationId, after: prior, model: model)
        try require(reply.text.range(of: #"\b5\b"#, options: .regularExpression) != nil, "Live follow-up did not use the saved report")
    }

    private static func send(_ text: String, in dm: String, model: ConversationModel) async throws -> String? {
        let prior = assistant(in: dm, model: model)?.id
        model.select(dm)
        model.edit(text, in: dm)
        await model.send()
        try require(model.local.pending == nil && model.problem == nil, model.problem ?? "Message did not get a receipt")
        return prior
    }

    private static func assistant(in dm: String, model: ConversationModel) -> Message? {
        model.snapshot?.messages.last { $0.conversationId == dm && $0.author == "assistant" }
    }

    private static func completed(in dm: String, after prior: String?, model: ConversationModel) async throws -> Message {
        try await wait("a completed live reply", model: model) {
            guard let message = assistant(in: dm, model: model) else { return false }
            return message.id != prior && ["completed", "blocked", "waiting_for_user"].contains(message.state)
        }
        guard let message = assistant(in: dm, model: model) else { throw ClientError(message: "Live reply missing") }
        try require(message.state == "completed", "Live reply ended in \(message.state)")
        return message
    }

    private static func wait(_ description: String, model: ConversationModel, until ready: () -> Bool) async throws {
        for _ in 0..<600 {
            if ready() { return }
            if model.snapshot?.runners.contains(where: { $0.status == "sign_in_needed" }) == true {
                throw ClientError(message: "The packaged runner requires Codex sign-in")
            }
            try await Task.sleep(for: .milliseconds(250))
        }
        throw ClientError(message: "Timed out waiting for \(description)")
    }

    private static func require(_ condition: Bool, _ message: String) throws {
        if !condition { throw ClientError(message: message) }
    }
}
