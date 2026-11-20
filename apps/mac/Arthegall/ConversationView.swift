import SwiftUI

struct ConversationView: View {
    @ObservedObject var model: ConversationModel
    let dm: Conversation

    var body: some View {
        let messages = model.snapshot?.messages.filter { $0.conversationId == dm.id } ?? []
        VStack(spacing: 0) {
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
                Transcript(dm: dm, messages: messages, runs: model.snapshot?.runs ?? [])
            }
            Composer(model: model, dm: dm)
                .frame(maxWidth: WorkspaceStyle.readingWidth)
                .padding(.horizontal, 22).padding(.top, 8).padding(.bottom, 18)
        }
        .background(WorkspaceStyle.canvas)
    }

    private var emptyHint: String {
        if dm.closed != 0 { return "This conversation is closed." }
        if dm.administrator == 1 { return "Describe an agent you’d like to create, or ask about your workspace." }
        return "Send a message to start your conversation with \(dm.name)."
    }
}

private struct Transcript: View {
    let dm: Conversation
    let messages: [Message]
    let runs: [Snapshot.RunSummary]
    @State private var followsLatest = true
    @State private var lastHeight: CGFloat = 0

    var body: some View {
        let states = Dictionary(runs.map { ($0.messageId, $0.state) }, uniquingKeysWith: { _, latest in latest })
        GeometryReader { viewport in
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 22) {
                        ForEach(messages) { message in
                            MessageRow(dm: dm, message: message, runState: states[message.id])
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
                .coordinateSpace(name: "transcript")
                .onAppear { proxy.scrollTo("latest", anchor: .bottom) }
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
                if !user {
                    MessageStatus(state: runState ?? message.state)
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

    private var status: (String, String, Color)? {
        switch state {
        case "complete", "completed": nil
        case "queued": ("Queued for runner", "clock", .secondary)
        case "accepted", "running", "streaming": ("Responding…", "waveform", WorkspaceStyle.pine)
        case "approval", "awaiting_access": ("Awaiting approval in browser", "hand.raised", .orange)
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

private struct Composer: View {
    @ObservedObject var model: ConversationModel
    let dm: Conversation
    @FocusState private var focused: Bool

    var body: some View {
        let pending = model.local.pending != nil
        let draft = model.local.pending?.text ?? model.local.drafts[dm.id] ?? ""
        let tooLong = draft.utf16.count > 16_000
        let label = pending ? "Retry Send" : "Send"
        VStack(alignment: .leading, spacing: 8) {
            if !model.online {
                Label(model.connectionStatus, systemImage: "wifi.slash")
            } else if model.snapshot?.runnerConnected == false {
                Label("Runner disconnected · Messages will queue", systemImage: "clock")
            }
            VStack(alignment: .leading, spacing: 8) {
                TextField(dm.closed != 0 ? "Conversation closed" : "Message \(dm.name)…",
                          text: Binding(get: { draft }, set: { model.edit($0, in: dm.id) }), axis: .vertical)
                    .textFieldStyle(.plain).lineLimit(1...6)
                    .font(.system(size: 14)).foregroundStyle(.primary).focused($focused)
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
                RoundedRectangle(cornerRadius: 13).strokeBorder(focused ? WorkspaceStyle.pine : WorkspaceStyle.hairline)
                    .allowsHitTesting(false)
            }
            .shadow(color: .black.opacity(0.035), radius: 4, y: 2)
        }
        .font(.caption).foregroundStyle(.secondary)
    }
}
