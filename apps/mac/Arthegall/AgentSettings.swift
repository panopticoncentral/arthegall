import SwiftUI

struct AgentSettings: View {
    @ObservedObject var model: ConversationModel
    let dm: Conversation
    let snapshot: Snapshot
    let assignment: Bool
    let navigate: (SettingsPage) -> Void
    let openConversation: (String, String?) -> Void
    @State private var details: ReportingSettings?
    @State private var loadError: String?
    @State private var reload = 0
    @State private var editing = false
    @State private var edit = DefinitionChange(revision: 0, instructions: "")
    @State private var proposing = false
    @State private var proposal = ScheduleChange(activeId: nil, time: "08:00", backfill: false)
    @State private var confirmClose = false

    private var schedules: [ReportSchedule] { snapshot.schedules.filter { $0.conversationId == dm.id } }
    private var active: ReportSchedule? { schedules.first { $0.state == "active" } }
    private var pending: ReportSchedule? { schedules.first { $0.state == "pending" } }
    private var assignmentName: String { schedules.isEmpty ? "Usage reporting assignment" : "Daily usage report" }
    private var canChange: Bool { model.online && !model.savingSettings && snapshot.recovery == nil && dm.closed == 0 }
    private var canOpenDM: Bool { model.local.pending == nil || model.selected == dm.id }

    var body: some View {
        Form {
            Section {
                if assignment {
                    LabeledContent("Owner") { Button(dm.name) { navigate(.agent(dm.id)) } }
                    LabeledContent("Assignment", value: dm.closed == 0 ? "Open" : "Closed")
                }
                Button("Open \(dm.name)’s DM") { openConversation(dm.id, nil) }.disabled(!canOpenDM)
            } header: {
                Text(assignment ? assignmentName : dm.name).font(.title2)
            }
            if let loadError {
                Text(verbatim: loadError).foregroundStyle(.red)
                Button("Retry") { reload += 1 }
            }
            if let details {
                if assignment { assignmentSections(details) } else { agentSections(details) }
            } else if loadError == nil {
                ProgressView("Loading settings…")
            }
        }
        .formStyle(.grouped)
        .task(id: "\(snapshot.cursor)/\(reload)/\(model.online)") {
            do {
                let next = try await model.reportingSettings(for: dm.id)
                try Task.checkCancellation()
                details = next
                loadError = nil
            } catch {
                if !Task.isCancelled { loadError = error.localizedDescription }
            }
        }
        .confirmationDialog("Close this reporting assignment and end its access?", isPresented: $confirmClose) {
            Button("Close assignment", role: .destructive) { save("close", [String: String]()) }
        } message: { Text("Its conversation and reports will remain available.") }
    }

    @ViewBuilder private func agentSections(_ details: ReportingSettings) -> some View {
        Section("Agent instructions") {
            if editing {
                TextField("Instructions for \(dm.name)’s future work", text: $edit.instructions, axis: .vertical)
                    .lineLimit(3...10).accessibilityIdentifier("agent-instructions")
                if edit.revision != details.revision {
                    Text("The agent definition has changed. Cancel to review the latest revision before editing.")
                        .foregroundStyle(.secondary)
                }
                HStack {
                    Button("Save revision") { save("definition", edit) }
                        .disabled(!canChange || edit.revision != details.revision ||
                                  edit.instructions.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
                                  edit.instructions.utf16.count > 2000)
                    Button("Cancel") { editing = false; model.settingsError = nil }
                }
            } else {
                Text(verbatim: details.instructions).textSelection(.enabled)
                Button("Edit instructions") {
                    editing = true
                    edit = DefinitionChange(revision: details.revision, instructions: details.instructions)
                }.disabled(!canChange || loadError != nil)
            }
            DisclosureGroup("Revision history · Revision \(details.revision)") {
                ForEach(details.history, id: \.revision) { item in
                    VStack(alignment: .leading) {
                        Text("Revision \(item.revision)").font(.headline)
                        Text(verbatim: item.instructions).textSelection(.enabled)
                    }
                }
            }
            LabeledContent("Execution preferences", value: "Codex · Runner default model and effort")
        }
        Section("Assignments") {
            Button(assignmentName) { navigate(.assignment(dm.id)) }
            Text(dm.closed != 0 ? "Closed" : active.map { "Daily at \($0.time) Pacific" } ?? "On demand")
        }
        Section("Tools and access") {
            accessSummary(details)
            Button("Review assignment access") { navigate(.assignment(dm.id)) }
        }
    }

    @ViewBuilder private func assignmentSections(_ details: ReportingSettings) -> some View {
        Section("Instructions and preferences") {
            Text(verbatim: details.assignmentInstructions).textSelection(.enabled)
            LabeledContent("Saved preference", value: details.preference?.instructions ?? "No saved preference")
            if let preference = details.preference {
                Button("View source reply") { openConversation(dm.id, preference.messageId) }.disabled(!canOpenDM)
            }
        }
        Section("Schedule and delivery") {
            if let active {
                LabeledContent("Active schedule", value: "Daily at \(active.time) · America/Los_Angeles")
                Text(missedRuns(active))
            } else { Text(dm.closed == 0 ? "On demand" : "Assignment closed") }
            if dm.closed == 0 && pending == nil {
                if proposing {
                    TextField("Daily time · Pacific (HH:mm)", text: $proposal.time)
                    Toggle("Backfill every missed report", isOn: $proposal.backfill)
                    HStack {
                        Button("Review change") { save("schedule", proposal) }
                            .disabled(!canChange || !validTime(proposal.time) ||
                                      (active?.time == proposal.time && (active?.backfill == 1) == proposal.backfill))
                        Button("Cancel") { proposing = false; model.settingsError = nil }
                    }
                } else {
                    Button(active == nil ? "Schedule daily reports" : "Change schedule") {
                        proposing = true
                        proposal = ScheduleChange(activeId: active?.id, time: active?.time ?? "08:00", backfill: active?.backfill == 1)
                    }.disabled(!canChange)
                }
            }
        }
        Section("Tools and access") { accessSummary(details) }
        if let pending {
            Section("Recurring reporting access requested") {
                Text("Allow \(pending.name) to use the local runner and read_usage every day at \(pending.time) America/Los_Angeles? Each report covers the previous Pacific calendar day.")
                Text(missedRuns(pending))
                Text("Access includes replies about saved evidence and lasts until the schedule is replaced or the assignment closes.")
                scope(assignment: pending.assignmentId, runner: pending.runnerId)
                HStack {
                    Button("Allow recurring reports") { decideSchedule(pending, "accept") }
                    Button("Decline schedule") { decideSchedule(pending, "decline") }
                }.disabled(!canChange)
            }
        }
        ForEach(snapshot.grants.filter { $0.conversationId == dm.id }) { grant in
            Section("Reporting access requested") {
                Text("\(grant.name) requests the local runner and read_usage for on-demand reports. The tool reads local Codex and Claude activity and returns aggregate counts and coverage.")
                if let assignment = grant.assignmentId, let runner = grant.runnerId {
                    scope(assignment: assignment, runner: runner)
                    Group {
                        Button("Allow for this assignment") { decideAccess(grant, "accept", "assignment") }
                        Button("Allow next run only") { decideAccess(grant, "accept", "run") }
                        Button("Decline") { decideAccess(grant, "decline", "assignment") }
                    }.disabled(!canChange)
                } else { Text("This server did not provide the assignment and runner for this request.") }
            }
        }
        if dm.closed == 0 {
            Button("Close reporting assignment…", role: .destructive) { confirmClose = true }.disabled(!canChange)
        }
    }

    @ViewBuilder private func accessSummary(_ details: ReportingSettings) -> some View {
        ForEach(Array(details.access.enumerated()), id: \.offset) { _, grant in
            Text("Local runner · read_usage · " + (grant.duration == "assignment" ? "Until the assignment closes" :
                    grant.usedBy == nil ? "Next run only" : "Current run only"))
        }
        if active != nil { Text("Local runner · read_usage · Each scheduled run and replies about its results") }
        else if details.access.isEmpty { Text(dm.closed == 0 ? "No current grant." : "Access ended when this assignment closed.") }
    }

    private func scope(assignment: String, runner: String) -> some View {
        VStack(alignment: .leading) {
            Text("Assignment \(assignment)")
            Text("Runner \(runner)")
        }.font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
    }

    private func missedRuns(_ schedule: ReportSchedule) -> String {
        schedule.backfill != 0 ? "Deliver every missed report." : "Deliver the latest report and record earlier missed dates."
    }

    private func validTime(_ time: String) -> Bool {
        time.range(of: #"^([01][0-9]|2[0-3]):[0-5][0-9]$"#, options: .regularExpression) != nil
    }

    private func save<Body: Encodable & Sendable>(_ action: String, _ body: Body) {
        Task {
            if await model.saveSetting("conversations/\(dm.id)/" + action, body) {
                editing = false
                proposing = false
            }
            reload += 1
        }
    }

    private func decideSchedule(_ schedule: ReportSchedule, _ decision: String) {
        Task { await model.saveSetting("schedules/" + schedule.id, ["decision": decision]) }
    }

    private func decideAccess(_ grant: AccessRequest, _ decision: String, _ duration: String) {
        Task { await model.saveSetting("access/" + grant.id, ["decision": decision, "duration": duration]) }
    }
}
