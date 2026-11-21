import SwiftUI

struct RunDetailsView: View {
    @ObservedObject var model: ConversationModel
    let runID: String
    @Environment(\.dismiss) private var dismiss
    @State private var events: [RunActivityPage.Event] = []
    @State private var nextBefore: Int?
    @State private var loadedHistory: Snapshot.RunSummary.History?
    @State private var loading = false
    @State private var activityError: String?
    @State private var requestID = UUID()

    private var run: Snapshot.RunSummary? { model.snapshot?.runs?.first { $0.id == runID } }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Run details").font(.title2).fontWeight(.medium)
                Spacer()
                Button("Done") { dismiss() }.keyboardShortcut(.cancelAction)
            }
            .padding()
            if let run {
                Form {
                    Section("Execution history") {
                        Text("Run \(run.id)").textSelection(.enabled)
                        switch run.history {
                        case .full:
                            Text(run.pinned == 0 ? "Details follow the server’s retention policy." : "Pinned to keep execution details and evidence.")
                            Button(run.pinned == 0 ? "Pin run" : "Unpin run") {
                                Task { await model.setPinned(run.pinned == 0, runID: runID) }
                            }.disabled(!model.online || model.savingSettings || model.snapshot?.recovery != nil)
                        case .pending:
                            Text("Cleanup awaiting runner confirmation")
                        case .pruned:
                            Text("Detailed execution history pruned")
                        }
                        if let error = model.settingsError ?? run.historyError {
                            Text(verbatim: error).foregroundStyle(.red).textSelection(.enabled)
                        }
                    }
                    Section("Activity") {
                        if loading { ProgressView("Loading activity…") }
                        if let activityError { Text(verbatim: activityError).foregroundStyle(.red) }
                        if run.history == loadedHistory {
                            if events.isEmpty && !loading && activityError == nil { Text("No activity recorded for this run.") }
                            ForEach(events) { event in
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(verbatim: event.detail ?? event.kind.replacingOccurrences(of: "_", with: " ").capitalized)
                                    Text("\(event.createdAt) UTC").font(.caption).foregroundStyle(.secondary)
                                }.textSelection(.enabled)
                            }
                            if let nextBefore {
                                Button("Load older activity") { Task { await load(run.history, before: nextBefore) } }
                                    .disabled(!model.online || loading)
                            }
                        }
                        Button("Refresh activity") { Task { await load(run.history) } }.disabled(!model.online || loading)
                    }
                }.formStyle(.grouped)
            } else {
                ContentUnavailableView("Run unavailable", systemImage: "clock")
            }
        }
        .frame(minWidth: 480, idealWidth: 570, minHeight: 340, idealHeight: 440)
        .task(id: ActivityState(history: run?.history, online: model.online)) {
            if let run, model.online { await load(run.history) }
        }
    }

    private struct ActivityState: Equatable {
        let history: Snapshot.RunSummary.History?
        let online: Bool
    }

    @MainActor private func load(_ history: Snapshot.RunSummary.History, before: Int? = nil) async {
        let request = UUID()
        requestID = request
        loading = true
        activityError = nil
        defer { if requestID == request { loading = false } }
        do {
            let page = try await model.runActivity(for: runID, before: before)
            guard requestID == request, run?.history == history else { return }
            if before == nil { events = page.events }
            else { events.append(contentsOf: page.events) }
            nextBefore = page.nextBefore
            loadedHistory = history
        } catch {
            if requestID == request && !Task.isCancelled { activityError = error.localizedDescription }
        }
    }
}
