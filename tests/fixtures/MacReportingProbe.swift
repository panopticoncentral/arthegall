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
            let access = await model.saveSetting("access/" + grant.id, ["decision": "accept", "duration": "run"])
            try check(access, "next-run access approved")
            try await wait("on-demand report") { report(model, "2020-06-13")?.evidence?.codex.total == 33 }
            model.edit("Schedule Rowan’s daily report at 8:00 AM Pacific.", in: admin)
            await model.send()
            try await wait("schedule proposal") { pendingSchedule(model) != nil }
            let schedule = try value(pendingSchedule(model), "pending schedule")
            try check(schedule.time == "08:00" && schedule.backfill == 0, "schedule scope")
            let approval = await model.saveSetting("schedules/" + schedule.id, ["decision": "accept"])
            try check(approval, "daily schedule approved")
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
            let active = try value(model.snapshot?.schedules.first { $0.state == "active" }, "active schedule")
            let schedulePath = "conversations/\(first.conversationId)/schedule"
            let proposed = await model.saveSetting(schedulePath, ScheduleChange(activeId: active.id, time: "09:00", backfill: false))
            try check(proposed, "replacement proposed")
            let replacement = try value(pendingSchedule(model), "replacement")
            let declined = await model.saveSetting("schedules/" + replacement.id, ["decision": "decline"])
            try check(declined && pendingSchedule(model) == nil, "replacement declined on Mac")
            let reproposed = await model.saveSetting(schedulePath, ScheduleChange(activeId: active.id, time: "10:00", backfill: true))
            try check(reproposed, "second replacement proposed")
            let stale = try value(pendingSchedule(model), "stale proposal")
            var request = URLRequest(url: fixture.fixtureURL)
            request.httpMethod = "POST"
            request.setValue(fixture.origin, forHTTPHeaderField: "Origin")
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(["decline": stale.id])
            let (_, response) = try await URLSession.shared.data(for: request)
            try check((response as? HTTPURLResponse)?.statusCode == 200, "second paired client declined")
            let accepted = await model.saveSetting("schedules/" + stale.id, ["decision": "accept"])
            try check(!accepted && model.settingsError != nil && pendingSchedule(model) == nil, "stale decision rejected and refreshed")
            try check(model.snapshot?.schedules.first { $0.state == "active" }?.id == active.id, "original schedule preserved")
            await model.unpair()
            try check(model.pairing == nil, "fixture pairing removed")
        default: throw ClientError(message: "Unknown reporting phase")
        }
        print("Mac reporting phase passed: \(phase)")
    }

    private static func report(_ model: ConversationModel, _ day: String) -> Message? {
        model.snapshot?.messages.first { $0.evidence?.range.start == day }
    }

    private static func pendingSchedule(_ model: ConversationModel) -> ReportSchedule? {
        model.snapshot?.schedules.first { $0.state == "pending" }
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
