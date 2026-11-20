import SwiftUI

@main
struct ArthegallApp: App {
    @StateObject private var model = ConversationModel()

    var body: some Scene {
        Window("Arthegall", id: "conversations") {
            ContentView(model: model)
                .frame(minWidth: 660, minHeight: 440)
        }
        .defaultSize(width: 900, height: 640)
    }
}

private struct ContentView: View {
    @ObservedObject var model: ConversationModel
    @State private var address = "http://127.0.0.1:4317"
    @State private var code = ""
    @State private var generation = UUID()
    @State private var confirmUnpair = false

    var body: some View {
        VStack(spacing: 0) {
            if model.pairing == nil {
                Form {
                    Text("Connect to Arthegall").font(.title)
                    TextField("Server address", text: $address)
                    SecureField("Pairing code", text: $code)
                    Button("Pair Mac") {
                        Task {
                            await model.pair(address: address, code: code)
                            if model.pairing != nil { code = "" }
                        }
                    }
                    .keyboardShortcut(.defaultAction)
                    .disabled(model.busy || code.isEmpty)
                }
                .frame(maxWidth: 420).padding(32)
            } else {
                NavigationSplitView {
                    List(model.snapshot?.conversations ?? [], selection: Binding(
                        get: { model.selected }, set: { model.select($0) }
                    )) { dm in
                        Text(dm.name).tag(dm.id)
                    }
                    .navigationTitle("Conversations")
                    .disabled(model.local.pending != nil)
                } detail: {
                    if let dm = model.snapshot?.conversations.first(where: { $0.id == model.selected }) {
                        transcript(dm).navigationTitle(dm.name)
                    } else {
                        Text(model.connectionStatus).foregroundStyle(.secondary)
                    }
                }
                .toolbar {
                    Menu {
                        Text(model.pairing?.origin.absoluteString ?? "")
                        Button("Unpair This Mac…") { confirmUnpair = true }
                            .disabled(model.busy)
                    } label: { Label("Connection", systemImage: "network") }
                    .accessibilityIdentifier("connection-menu")
                }
                .confirmationDialog("Unpair this Mac?", isPresented: $confirmUnpair) {
                    Button("Unpair", role: .destructive) { Task { await model.unpair() } }
                } message: { Text("You’ll need a new pairing code to open these conversations again.") }
            }
            if let problem = model.problem { Text(problem).foregroundStyle(.red).textSelection(.enabled).padding(8) }
        }
        .onReceive(NSWorkspace.shared.notificationCenter.publisher(for: NSWorkspace.didWakeNotification)) { _ in generation = UUID() }
        .task(id: (model.pairing?.session.sessionId.uuidString ?? "") + generation.uuidString) { await model.follow() }
    }

    private func transcript(_ dm: Conversation) -> some View {
        let rows = model.snapshot?.messages.filter { $0.conversationId == dm.id } ?? []
        let draft = model.local.pending?.text ?? model.local.drafts[dm.id] ?? ""
        return VStack(alignment: .leading, spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 16) {
                        ForEach(rows) { message in
                            VStack(alignment: .leading, spacing: 4) {
                                Text(message.author == "user" ? "You" : dm.name).font(.headline)
                                if !message.text.isEmpty { Text(verbatim: message.text).textSelection(.enabled) }
                                if !["complete", "completed"].contains(message.state) {
                                    Text(message.state.replacingOccurrences(of: "_", with: " ")).foregroundStyle(.secondary)
                                }
                            }.id(message.id)
                        }
                    }.frame(maxWidth: .infinity, alignment: .leading).padding()
                }
                .onChange(of: rows.last?.id, initial: true) { _, last in
                    if let last { proxy.scrollTo(last, anchor: .bottom) }
                }
            }
            Divider()
            VStack(alignment: .leading) {
                if !model.online { Text(model.connectionStatus).foregroundStyle(.secondary) }
                else if model.snapshot?.runnerConnected == false { Text("Runner disconnected · Messages will queue").foregroundStyle(.secondary) }
                TextField("Message " + dm.name, text: Binding(get: { draft }, set: { model.edit($0, in: dm.id) }), axis: .vertical)
                    .accessibilityIdentifier("message-composer")
                    .lineLimit(2...6).textFieldStyle(.roundedBorder)
                    .disabled(dm.closed != 0 || model.local.pending != nil)
                HStack {
                    Spacer()
                    Button(model.local.pending == nil ? "Send" : "Retry Send") { Task { await model.send() } }
                        .keyboardShortcut(.return, modifiers: .command)
                        .disabled(!model.online || model.busy || (dm.closed != 0 && model.local.pending == nil) ||
                                  draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || draft.utf16.count > 16_000)
                }
            }.padding()
        }
    }
}
