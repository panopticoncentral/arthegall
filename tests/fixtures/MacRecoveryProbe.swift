import Foundation

@main
@MainActor
struct MacRecoveryProbe {
    struct Fixture: Decodable {
        let origin: String
        let code: String
        let dm: String
        let priorRun: String
        let controller: URL
    }

    struct Reply: Decodable {
        let messageId: String?
        let runId: String?
        let error: String?
    }

    static func main() async throws {
        try require(Bundle.main.bundleIdentifier?.hasPrefix("org.arthegall.fixture.") == true, "isolated test identity")
        let manifest = URL(fileURLWithPath: CommandLine.arguments[1])
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: manifest))
        let phase = CommandLine.arguments[2]
        let model = ConversationModel()
        if phase == "prepare" { await model.pair(address: fixture.origin, code: fixture.code) }
        try require(model.pairing != nil, model.problem ?? "paired app")
        let follow = Task { await model.follow() }
        defer { follow.cancel() }
        try await wait("connected") { model.online && model.snapshot?.recoveryVersion == 1 }

        switch phase {
        case "prepare":
            model.select(fixture.dm)
            let activity = try await model.runActivity(for: fixture.priorRun)
            try require(activity.events.contains { $0.detail == "Synthetic retained provider trace." }, "prior activity loaded")
            await model.setPinned(true, runID: fixture.priorRun)
            try require(model.snapshot?.runs?.first { $0.id == fixture.priorRun }?.pinned == 1, "pin saved")
            await model.setPinned(false, runID: fixture.priorRun)
            try require(model.snapshot?.runs?.first { $0.id == fixture.priorRun }?.pinned == 0, "unpin saved")
            let settings = try await model.reportingSettings(for: fixture.dm)
            _ = try await advance("edit-from-second-client", fixture: fixture)
            let saved = await model.saveSetting("conversations/\(fixture.dm)/definition",
                                                DefinitionChange(revision: settings.revision, instructions: "Synthetic stale edit."))
            try require(!saved && model.settingsError?.contains("changed") == true, "stale edit requires review")
            let report = try await advance("backup-and-deliver", fixture: fixture)
            guard let runID = report.runId else { throw ClientError(message: "Missing scheduled run ID") }
            try await wait("scheduled report available before restore") { model.snapshot?.messages.contains { $0.id == report.messageId } == true }
            await model.setPinned(true, runID: runID)
            try require(model.snapshot?.runs?.first { $0.id == runID }?.pinned == 1, "post-backup pin saved")
        case "recover":
            try require(model.selected == fixture.dm && model.snapshot?.recovery?.ready == false, "paired DM and paused server after relaunch")
            try require(model.snapshot?.recovery?.runners.first?.status == "offline", "runner initially offline")
            _ = try await advance("connect-incomplete-runner", fixture: fixture)
            try await wait("unresolved execution shown") { model.snapshot?.recovery?.issues.contains { $0.runId == fixture.priorRun } == true }
            await model.resumeDispatch()
            try require(model.snapshot?.recovery?.ready == false, "unresolved execution prevents resume")
            await model.recheckRunners()
            let replay = try await advance("connect-intact-runner", fixture: fixture)
            try await wait("recovery ready") { model.snapshot?.recovery?.ready == true }
            guard let report = model.snapshot?.messages.first(where: { $0.id == replay.messageId }) else {
                throw ClientError(message: "Recovered report is missing")
            }
            try require(report.evidence?.codex.total == 34 && report.text == "Synthetic total: 34", "saved report and evidence recovered")
            try require(model.snapshot?.runs?.first { $0.id == replay.runId }?.pinned == 1, "pin preserved through restore")
            model.reply(to: report, in: fixture.dm)
            model.edit("Put source coverage first from now on.", in: fixture.dm)
            await model.send()
            try await wait("scoped reply queued during pause") { model.snapshot?.runs?.contains { $0.state == "queued" } == true }
            await model.resumeDispatch()
            try await wait("queued reply delivered after resume") {
                model.snapshot?.recovery == nil && model.snapshot?.messages.contains { $0.text == "Saved your preference." } == true
            }
            _ = try await advance("prepare-cleanup", fixture: fixture)
            try await wait("cleanup pending") { model.snapshot?.runs?.first { $0.id == fixture.priorRun }?.history == .pending }
            _ = try await advance("finish-cleanup", fixture: fixture)
            try await wait("cleanup pruned") { model.snapshot?.runs?.first { $0.id == fixture.priorRun }?.history == .pruned }
            let retained = try await model.runActivity(for: fixture.priorRun)
            try require(!retained.events.contains { $0.detail == "Synthetic retained provider trace." }, "pruned activity removed")
            await model.unpair()
            try require(model.pairing == nil, "fixture pairing removed")
        default: throw ClientError(message: "Unknown recovery probe phase")
        }
        print("Mac recovery phase passed: \(phase)")
    }

    private static func advance(_ action: String, fixture: Fixture) async throws -> Reply {
        var request = URLRequest(url: fixture.controller.appendingPathComponent(action))
        request.httpMethod = "POST"
        let (data, response) = try await URLSession.shared.data(for: request)
        let result = try JSONDecoder().decode(Reply.self, from: data)
        try require((response as? HTTPURLResponse)?.statusCode == 200, result.error ?? action)
        return result
    }

    private static func require(_ condition: Bool, _ description: String) throws {
        if !condition { throw ClientError(message: description) }
    }

    private static func wait(_ description: String, _ condition: () -> Bool) async throws {
        for _ in 0..<200 {
            if condition() { return }
            try await Task.sleep(for: .milliseconds(100))
        }
        throw ClientError(message: "Timed out waiting for \(description)")
    }
}
