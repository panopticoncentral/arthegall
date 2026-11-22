import SwiftUI

struct ConversationView: View {
    @ObservedObject var model: ConversationModel
    let dm: Conversation

    let sourceMessage: String?
    let openAssignment: () -> Void
    let openRecovery: () -> Void
    @FocusState private var composerFocused: Bool
    @State private var selectedRun: Snapshot.RunSummary?

    var body: some View {
        let messages = model.snapshot?.messages.filter { $0.conversationId == dm.id } ?? []
        VStack(spacing: 0) {
            if model.snapshot?.recovery != nil {
                HStack {
                    Label("Dispatch paused after restore", systemImage: "pause.circle")
                    Spacer()
                    Button("Review recovery", action: openRecovery)
                }
                .padding(12).background(WorkspaceStyle.inset)
            }
            if messages.isEmpty {
                Color.clear.overlay {
                    VStack(alignment: .leading, spacing: 14) {
                        ConversationAvatar(dm: dm, size: 52)
                        Text(dm.name).font(.system(size: 32, weight: .medium, design: .serif))
                        Text(emptyHint).foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: 440, alignment: .leading)
                    .padding(32)
                }
            } else {
                Transcript(model: model, dm: dm, messages: messages, sourceMessage: sourceMessage,
                           openAssignment: openAssignment, openRun: {
                               model.settingsError = nil
                               selectedRun = $0
                           }, reply: { message in
                               model.reply(to: message, in: dm.id)
                               composerFocused = true
                           })
            }
            if let snapshot = model.snapshot, snapshot.settingsVersion == 1,
               snapshot.grants.contains(where: { $0.conversationId == dm.id }) {
                Button("Review reporting access", systemImage: "hand.raised", action: openAssignment)
                    .padding(.vertical, 6)
            }
            if let error = model.settingsError {
                Text(verbatim: error).foregroundStyle(.red).font(.caption).padding(.horizontal, 22)
            }
            Composer(model: model, dm: dm, focused: $composerFocused)
                .frame(maxWidth: WorkspaceStyle.readingWidth)
                .padding(.horizontal, 22).padding(.top, 8).padding(.bottom, 18)
        }
        .background(WorkspaceStyle.canvas)
        .sheet(item: $selectedRun) { run in RunDetailsView(model: model, runID: run.id) }
    }

    private var emptyHint: String {
        if dm.closed != 0 { return "This conversation is closed." }
        if dm.administrator == 1 { return "Describe an agent you’d like to create, or ask about your workspace." }
        return "Send a message to start your conversation with \(dm.name)."
    }
}

private struct Transcript: View {
    @ObservedObject var model: ConversationModel
    let dm: Conversation
    let messages: [Message]
    let sourceMessage: String?
    let openAssignment: () -> Void
    let openRun: (Snapshot.RunSummary) -> Void
    let reply: (Message) -> Void
    @State private var followsLatest = true
    @State private var lastHeight: CGFloat = 0

    var body: some View {
        let snapshot = model.snapshot
        let runs = Dictionary((snapshot?.runs ?? []).map { ($0.messageId, $0) }, uniquingKeysWith: { _, latest in latest })
        let approvals = Dictionary(grouping: (snapshot?.approvals ?? []).filter { $0.conversationId == dm.id }, by: \.runId)
        let supportsApprovals = snapshot?.commandApprovalsVersion == 1
        GeometryReader { viewport in
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 22) {
                        ForEach(messages) { message in
                            let run = runs[message.id]
                            let pending = run.flatMap { approvals[$0.id] } ?? []
                            let state = supportsApprovals && run?.state == "approval" && pending.isEmpty ? "decision_sent" : run?.state
                            MessageRow(dm: dm, message: message, runState: state,
                                       supportsApprovals: supportsApprovals, openAssignment: openAssignment,
                                       runDetails: run.flatMap { entry in
                                           snapshot?.recoveryVersion == 1 ? { openRun(entry) } : nil
                                       },
                                       reply: dm.closed == 0 && model.local.pending == nil ? { reply(message) } : nil)
                                .id(message.id)
                            if supportsApprovals {
                                ForEach(pending) { approval in
                                    CommandApprovalCard(approval: approval, agent: dm.name,
                                                        disabled: !model.online || model.savingSettings || snapshot?.recovery != nil) { allow in
                                        Task { await model.decideCommand(approval, allow: allow) }
                                    }
                                }
                            }
                        }
                    }
                    .frame(maxWidth: WorkspaceStyle.readingWidth)
                    .padding(.horizontal, 22).padding(.vertical, 24)
                    .frame(maxWidth: .infinity)
                    .background {
                        GeometryReader { content in
                            Color.clear.preference(key: TranscriptFrame.self, value: content.frame(in: .named("transcript")))
                        }
                    }
                    Color.clear.frame(height: 1).id("latest")
                }
                .accessibilityIdentifier("conversation-transcript")
                .coordinateSpace(name: "transcript")
                .onAppear {
                    if let sourceMessage {
                        followsLatest = false
                        proxy.scrollTo(sourceMessage, anchor: .center)
                    } else { proxy.scrollTo("latest", anchor: .bottom) }
                }
                .onPreferenceChange(TranscriptFrame.self) { frame in
                    let visible = frame.maxY <= viewport.size.height + 24
                    if followsLatest && frame.height != lastHeight {
                        proxy.scrollTo("latest", anchor: .bottom)
                    } else {
                        followsLatest = visible
                    }
                    lastHeight = frame.height
                }
                .overlay(alignment: .bottom) {
                    if !followsLatest {
                        Button {
                            proxy.scrollTo("latest", anchor: .bottom)
                            followsLatest = true
                        } label: {
                            Label("Latest messages", systemImage: "arrow.down")
                        }
                        .buttonStyle(.bordered).buttonBorderShape(.capsule)
                        .padding(.bottom, 5)
                    }
                }
            }
        }
        .accessibilityLabel("Conversation messages")
    }

}

private struct TranscriptFrame: PreferenceKey {
    static let defaultValue = CGRect.zero
    static func reduce(value: inout CGRect, nextValue: () -> CGRect) { value = nextValue() }
}

private struct MessageRow: View {
    let dm: Conversation
    let message: Message
    let runState: String?
    let supportsApprovals: Bool
    let openAssignment: () -> Void
    let runDetails: (() -> Void)?
    let reply: (() -> Void)?

    private var user: Bool { message.author == "user" }
    private var name: String {
        if message.requestedReport == 1 { return "Report request" }
        return user ? "You" : dm.name
    }

    var body: some View {
        HStack(alignment: .top, spacing: 11) {
            ConversationAvatar(dm: dm, user: user, size: 31)
            VStack(alignment: .leading, spacing: 6) {
                Text(name).font(.system(size: 13, weight: .bold))
                if !message.text.isEmpty {
                    if user || message.state == "streaming" {
                        Text(verbatim: message.text).font(.system(size: 14))
                            .lineSpacing(3).textSelection(.enabled)
                    } else {
                        MessageMarkdown(source: message.text).equatable()
                    }
                }
                if let evidence = message.evidence {
                    ReportDetails(id: message.id, source: message.text, evidence: evidence)
                    HStack {
                        if let reply {
                            Button("Reply to report", action: reply).buttonStyle(.link)
                                .accessibilityIdentifier("reply-to-" + message.id)
                        }
                        Button("Assignment settings", action: openAssignment).buttonStyle(.link)
                    }
                }
                if let runDetails {
                    Button("Run details", action: runDetails).buttonStyle(.link)
                        .accessibilityIdentifier("run-details-" + message.id)
                }
                if !user {
                    MessageStatus(state: runState ?? message.state, supportsApprovals: supportsApprovals)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(12)
        .background {
            if user { RoundedRectangle(cornerRadius: 11).fill(WorkspaceStyle.inset) }
        }
        .accessibilityElement(children: .contain)
        .contextMenu {
            Button("Copy Message") { copyText(message.text) }.disabled(message.text.isEmpty)
        }
    }
}

private struct MessageStatus: View {
    let state: String
    let supportsApprovals: Bool

    private var status: (String, String, Color)? {
        switch state {
        case "complete", "completed": nil
        case "queued": ("Queued for runner", "clock", .secondary)
        case "accepted", "running", "streaming": ("Responding…", "waveform", WorkspaceStyle.pine)
        case "awaiting_access": ("Awaiting reporting access", "hand.raised", .orange)
        case "approval": (supportsApprovals ? "Awaiting command approval" : "Update server to approve this command", "hand.raised", .orange)
        case "decision_sent": ("Command decision sent", "checkmark.circle", .secondary)
        case "waiting_for_user": ("Waiting for your reply", "bubble.left", WorkspaceStyle.pine)
        case "blocked": ("Blocked", "exclamationmark.circle", .red)
        default: (state.replacingOccurrences(of: "_", with: " ").capitalized, "circle", .secondary)
        }
    }

    var body: some View {
        if let (text, icon, color) = status {
            Label(text, systemImage: icon).font(.caption.weight(.medium))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 8).padding(.vertical, 4)
                .background(color.opacity(0.1), in: Capsule())
        }
    }
}

private struct CommandApprovalCard: View {
    let approval: Snapshot.CommandApproval
    let agent: String
    let disabled: Bool
    let decide: (Bool) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Command approval needed for \(agent)", systemImage: "hand.raised").font(.headline)
                .accessibilityAddTraits(.isHeader)
                .accessibilityIdentifier("command-approval-heading-" + approval.id)
            Text("Allow \(agent) to run this operation once?")
            Text(verbatim: "Command and scope. \(approval.command)")
                .font(.system(.body, design: .monospaced)).textSelection(.enabled)
            HStack {
                Button("Approve once") { decide(true) }
                    .accessibilityHint("Allows \(agent) to run the displayed command once.")
                Button("Decline command") { decide(false) }
                    .accessibilityHint("Denies this command request.")
            }.buttonStyle(.bordered).disabled(disabled)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(WorkspaceStyle.inset, in: RoundedRectangle(cornerRadius: 11))
    }
}

private struct Composer: View {
    @ObservedObject var model: ConversationModel
    let dm: Conversation
    let focused: FocusState<Bool>.Binding

    var body: some View {
        let pending = model.local.pending != nil
        let replyTo = pending ? model.local.pending?.replyTo : model.local.replyTargets?[dm.id]
        let draft = model.local.pending?.text ?? model.local.drafts[dm.id] ?? ""
        let tooLong = draft.utf16.count > 16_000
        let label = pending ? "Retry Send" : model.snapshot?.recovery != nil ? "Queue Message" : "Send"
        VStack(alignment: .leading, spacing: 8) {
            if !model.online {
                Label(model.connectionStatus, systemImage: "wifi.slash")
            } else if model.snapshot?.runnerConnected == false {
                Label("Runner disconnected · Messages will queue", systemImage: "clock")
            } else if model.snapshot?.runners.contains(where: { $0.status == "sign_in_needed" }) == true {
                Label("Codex sign-in needed on the runner", systemImage: "person.crop.circle.badge.exclamationmark")
            }
            VStack(alignment: .leading, spacing: 8) {
                if let replyTo {
                    let range = model.snapshot?.messages.first { $0.id == replyTo }?.evidence?.range.label
                    HStack {
                        Label(range.map { "Replying to report · \($0)" } ?? "Replying to selected report", systemImage: "arrowshape.turn.up.left")
                        Spacer()
                        Button("Clear reply target") { model.clearReply(in: dm.id) }.buttonStyle(.link).disabled(pending)
                    }
                }
                TextField(dm.closed != 0 ? "Conversation closed" : "Message \(dm.name)…",
                          text: Binding(get: { draft }, set: { model.edit($0, in: dm.id) }), axis: .vertical)
                    .textFieldStyle(.plain).lineLimit(1...6)
                    .font(.system(size: 14)).foregroundStyle(.primary).focused(focused)
                    .accessibilityIdentifier("message-composer")
                    .disabled(dm.closed != 0 || pending)
                HStack(alignment: .center, spacing: 8) {
                    if tooLong {
                        Text("\(draft.utf16.count) / 16,000").foregroundStyle(.red)
                    } else if pending && !model.busy {
                        Text("Message awaiting confirmation")
                    }
                    Spacer()
                    Text("⌘↩").accessibilityHidden(true)
                    Button {
                        Task { await model.send() }
                    } label: {
                        Label(label, systemImage: "arrow.up").labelStyle(.titleAndIcon)
                    }
                    .accessibilityLabel(label)
                    .buttonStyle(.borderedProminent).tint(WorkspaceStyle.pine)
                    .keyboardShortcut(.return, modifiers: .command)
                    .disabled(!model.online || model.busy || (dm.closed != 0 && !pending) ||
                              draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || tooLong)
                }
            }
            .padding(12)
            .background(WorkspaceStyle.surface, in: RoundedRectangle(cornerRadius: 13))
            .overlay {
                RoundedRectangle(cornerRadius: 13).strokeBorder(focused.wrappedValue ? WorkspaceStyle.pine : WorkspaceStyle.hairline)
                    .allowsHitTesting(false)
            }
            .shadow(color: .black.opacity(0.035), radius: 4, y: 2)
        }
        .font(.caption).foregroundStyle(.secondary)
    }
}
