import SwiftUI

enum SettingsPage: Hashable {
    case system, agents, agent(String), assignment(String)
}

struct WorkspaceSettings: View {
    @ObservedObject var model: ConversationModel
    let page: SettingsPage
    let navigate: (SettingsPage) -> Void
    let back: () -> Void
    let openConversation: (String, String?) -> Void
    let unpair: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Button("System") { navigate(.system) }
                    .fontWeight(page == .system ? .bold : .regular)
                Button("Agents") { navigate(.agents) }
                    .fontWeight(page != .system ? .bold : .regular)
                Spacer()
                Button("Back to conversation", action: back)
            }
            .padding()
            Divider()
            if !model.online {
                Label(model.connectionStatus, systemImage: "wifi.slash").padding(8)
            }
            if let error = model.settingsError {
                Label(error, systemImage: "exclamationmark.circle").foregroundStyle(.red)
                    .textSelection(.enabled).padding(8)
            }
            if let snapshot = model.snapshot {
                if snapshot.settingsVersion != 1 {
                    ContentUnavailableView("Update the Arthegall server to use Mac settings", systemImage: "gearshape")
                } else {
                    content(snapshot)
                }
            } else {
                ProgressView("Connecting to workspace…").frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .tint(WorkspaceStyle.pine)
        .navigationTitle("Settings")
    }

    @ViewBuilder private func content(_ snapshot: Snapshot) -> some View {
        switch page {
        case .system:
            SystemSettings(model: model, snapshot: snapshot, unpair: unpair)
        case .agents:
            Form {
                Section("Reporting agents") {
                    let agents = snapshot.conversations.filter { $0.administrator == 0 }
                    if agents.isEmpty { Text("Ask the Administrator to create a reporting agent.") }
                    ForEach(agents) { dm in
                        Button { navigate(.agent(dm.id)) } label: {
                            HStack {
                                ConversationAvatar(dm: dm, size: 30)
                                Text(dm.name)
                                Spacer()
                                Text(dm.closed == 0 ? "Reporting agent" : "Closed assignment").foregroundStyle(.secondary)
                                Image(systemName: "chevron.right")
                            }
                            .contentShape(Rectangle())
                        }.buttonStyle(.plain).accessibilityIdentifier("settings-agent-" + dm.id)
                    }
                }
            }.formStyle(.grouped)
        case .agent(let id), .assignment(let id):
            if let dm = snapshot.conversations.first(where: { $0.id == id && $0.administrator == 0 }) {
                AgentSettings(model: model, dm: dm, snapshot: snapshot, assignment: page == .assignment(id),
                              navigate: navigate, openConversation: openConversation)
                    .id(page)
            } else {
                ContentUnavailableView("Agent unavailable", systemImage: "person.crop.circle")
            }
        }
    }
}

private struct SystemSettings: View {
    @ObservedObject var model: ConversationModel
    let snapshot: Snapshot
    let unpair: () -> Void

    private var providerStatus: String {
        guard snapshot.runnerConnected else { return "Available when the runner reconnects" }
        switch snapshot.runners.first?.status {
        case "ready": return "Ready"
        case "sign_in_needed": return "Run codex login on the runner"
        default: return "Availability is checked when work starts"
        }
    }

    var body: some View {
        Form {
            if let recovery = snapshot.recovery {
                Section("Restore recovery") {
                    Label("Dispatch paused after restore", systemImage: "pause.circle")
                    ForEach(recovery.runners) { runner in
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Runner \(runner.id)").textSelection(.enabled)
                            Text(recoveryStatus(runner.status)).foregroundStyle(.secondary)
                        }
                    }
                    ForEach(recovery.issues) { issue in
                        VStack(alignment: .leading, spacing: 4) {
                            Label("Run \(issue.runId)", systemImage: "exclamationmark.triangle")
                            Text(verbatim: issue.reason).foregroundStyle(.secondary)
                        }.textSelection(.enabled)
                    }
                    if recovery.ready {
                        Label("All runner records agree. Dispatch can safely resume.", systemImage: "checkmark.circle")
                    }
                    if snapshot.recoveryVersion == 1 {
                        HStack {
                            Button("Check runners again") { Task { await model.recheckRunners() } }
                            Button("Resume dispatch") { Task { await model.resumeDispatch() } }
                                .disabled(!recovery.ready)
                        }.buttonStyle(.bordered).disabled(!model.online || model.savingSettings)
                    } else {
                        Text("Open the browser or update this server to manage restore recovery from the Mac app.")
                    }
                }
            }
            Section("Connections") {
                LabeledContent("Server", value: model.pairing?.origin.absoluteString ?? "")
                LabeledContent("Local runner", value: snapshot.runnerConnected ? "Connected" : "Waiting for runner")
                LabeledContent("Codex", value: providerStatus)
                DisclosureGroup("Paired clients (\(snapshot.pairings.count))") {
                    ForEach(Array(snapshot.pairings.enumerated()), id: \.offset) { _, pairing in
                        LabeledContent(pairing.current == 1 ? "This Mac" : "Other client",
                                       value: "Expires " + serverDate(pairing.expires))
                    }
                }
                Button("Unpair This Mac…", action: unpair).disabled(!model.online || model.busy)
            }
            if let status = snapshot.backups {
                BackupSettingsForm(model: model, status: status, paused: snapshot.recovery != nil)
            }
            Section("Execution history") {
                RetentionSettings(model: model, days: snapshot.retentionDays)
                    .id(snapshot.retentionDays)
                    .disabled(!model.online || model.savingSettings || snapshot.recovery != nil)
            }
        }.formStyle(.grouped)
    }

    private func recoveryStatus(_ status: String) -> String {
        switch status {
        case "offline": "Offline · Waiting for reconnect"
        case "unsupported": "Update the runner to check its durable records"
        case "checking": "Checking durable records"
        case "checked": "Inventory checked"
        default: "Status unavailable"
        }
    }
}

private func serverDate(_ milliseconds: Double) -> String {
    Date(timeIntervalSince1970: milliseconds / 1000).formatted(date: .abbreviated, time: .shortened)
}

private struct RetentionSettings: View {
    @ObservedObject var model: ConversationModel
    let days: Int
    @State private var value: String

    init(model: ConversationModel, days: Int) {
        self.model = model
        self.days = days
        _value = State(initialValue: String(days))
    }

    var body: some View {
        TextField("Days to keep completed run details", text: $value)
            .accessibilityLabel("Days to keep completed run details").accessibilityIdentifier("retention-days")
        Text("Retention applies to unpinned run details. Reports and recorded usage stay in the conversation.")
            .font(.callout).foregroundStyle(.secondary)
        Button("Save history retention") {
            if let days = Int(value) { Task { await model.saveSetting("retention", ["days": days]) } }
        }.disabled((Int(value) ?? 0) < 1 || Int(value) == days)
    }
}

private struct BackupSettingsForm: View {
    @ObservedObject var model: ConversationModel
    let status: BackupStatus
    let paused: Bool
    @State private var destination = ""
    @State private var copies = ""

    var body: some View {
        Section("Daily server backups") {
            Text(status.enabled ? "Daily at 3:00 AM (\(status.timeZone))" : "Off. Enabling takes the first backup immediately.")
            if let last = status.lastSuccess, let path = status.lastPath {
                LabeledContent("Last verified", value: serverDate(last))
                Text(verbatim: path).textSelection(.enabled)
            }
            if paused && status.enabled { Text("Daily backups will resume after restore reconciliation.") }
            else if status.running { Text("Checking backup and retention…") }
            else if status.enabled, let due = status.nextDue { LabeledContent("Next attempt", value: serverDate(due)) }
            if let error = status.error { Text(verbatim: error).foregroundStyle(.red).textSelection(.enabled) }
            Group {
                TextField("Backup folder on the server", text: $destination, prompt: Text("Absolute server path"))
                    .accessibilityLabel("Backup folder on the server").accessibilityIdentifier("backup-folder")
                TextField("Daily copies to keep", text: $copies)
                Button(status.enabled ? "Save backup settings" : "Enable daily backups") {
                    if let keep = Int(copies) { save(destination, keep, enabled: true) }
                }.disabled(destination.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || (Int(copies) ?? 0) < 1)
                if status.enabled {
                    Button("Turn off daily backups") { save(status.destination, status.keep, enabled: false) }
                    if status.error != nil {
                        Button("Retry daily backup") { Task { await model.saveSetting("backups/retry", [String: String]()) } }
                    }
                }
            }.disabled(!model.online || model.savingSettings || status.running)
        }
        .onChange(of: status.destination, initial: true) { _, path in destination = path }
        .onChange(of: status.keep, initial: true) { _, keep in copies = String(keep) }
    }

    private func save(_ destination: String, _ keep: Int, enabled: Bool) {
        Task { await model.saveSetting("backups/settings", BackupChange(destination: destination, keep: keep, enabled: enabled)) }
    }
}
