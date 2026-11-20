import SwiftUI

@main
struct ArthegallApp: App {
    @StateObject private var model = ConversationModel()

    var body: some Scene {
        Window("Arthegall", id: "conversations") {
            ContentView(model: model)
                .frame(minWidth: 660, minHeight: 440)
        }
        .windowToolbarStyle(.unified)
        .defaultSize(width: 1000, height: 700)
    }
}

private struct ContentView: View {
    @ObservedObject var model: ConversationModel
    @State private var generation = UUID()
    @State private var confirmUnpair = false

    var body: some View {
        VStack(spacing: 0) {
            if let pairing = model.pairing {
                workspace(pairing)
            } else {
                PairingView(model: model)
            }
            if let problem = model.problem {
                Label(problem, systemImage: "exclamationmark.circle")
                    .foregroundStyle(.primary).textSelection(.enabled)
                    .padding(10).frame(maxWidth: .infinity, alignment: .leading)
                    .background(.red.opacity(0.09))
            }
        }
        .onReceive(NSWorkspace.shared.notificationCenter.publisher(for: NSWorkspace.didWakeNotification)) { _ in generation = UUID() }
        .task(id: (model.pairing?.session.sessionId.uuidString ?? "") + generation.uuidString) { await model.follow() }
    }

    private func workspace(_ pairing: Pairing) -> some View {
        let conversations = model.snapshot?.conversations ?? []
        return NavigationSplitView {
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 8) {
                    BrandIcon(size: 40)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Arthegall").font(.system(size: 22, weight: .semibold, design: .serif))
                        Text(verbatim: pairing.origin.host() ?? pairing.origin.absoluteString)
                            .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
                .padding(.horizontal, 14).padding(.top, 8).padding(.bottom, 22)
                List(selection: Binding(get: { model.selected }, set: { model.select($0) })) {
                    Section("Direct messages") {
                        ForEach(conversations) { dm in
                            HStack(spacing: 9) {
                                ConversationAvatar(dm: dm, size: 30)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(dm.name).fontWeight(.semibold).lineLimit(1)
                                    Text(dm.administrator == 1 ? "Workspace setup" : "Reporting agent")
                                        .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                                }
                                Spacer(minLength: 2)
                                if dm.closed != 0 {
                                    Image(systemName: "archivebox").accessibilityLabel("Closed")
                                } else if !(model.local.drafts[dm.id] ?? "").isEmpty {
                                    Image(systemName: "pencil").accessibilityLabel("Draft")
                                }
                            }
                            .padding(.vertical, 4).tag(dm.id)
                            .accessibilityElement(children: .combine)
                            .accessibilityIdentifier("conversation-" + dm.id)
                        }
                    }
                }
                .listStyle(.sidebar)
                .scrollContentBackground(.hidden)
                .disabled(model.local.pending != nil)
            }
            .background(WorkspaceStyle.sidebar.ignoresSafeArea())
            .tint(WorkspaceStyle.pine)
            .navigationSplitViewColumnWidth(min: 176, ideal: 215, max: 300)
        } detail: {
            if let dm = conversations.first(where: { $0.id == model.selected }) {
                ConversationView(model: model, dm: dm)
                    .id(dm.id)
                    .navigationTitle(dm.name)
                    .navigationSubtitle(dm.closed != 0 ? "Closed conversation" : "Direct message")
            } else {
                ContentUnavailableView {
                    Label(model.online ? "No conversations yet" : "Connecting to workspace", systemImage: "bubble.left.and.bubble.right")
                } description: {
                    if !model.online { Text(model.connectionStatus) }
                }
            }
        }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    Text(pairing.origin.absoluteString)
                    Button("Unpair This Mac…") { confirmUnpair = true }.disabled(model.busy)
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: model.online ? "circle.fill" : "circle.dashed")
                            .font(.system(size: 8)).foregroundStyle(model.online ? WorkspaceStyle.pine : Color.secondary)
                        Text(model.online ? "Connected" : "Connecting…").font(.callout)
                    }
                }
                .accessibilityLabel("Connection").accessibilityIdentifier("connection-menu")
                .help("Connection to " + pairing.origin.absoluteString)
            }
        }
        .confirmationDialog("Unpair this Mac?", isPresented: $confirmUnpair) {
            Button("Unpair", role: .destructive) { Task { await model.unpair() } }
        } message: { Text("You’ll need a new pairing code to open these conversations again.") }
    }
}

private struct PairingView: View {
    @ObservedObject var model: ConversationModel
    @State private var address = "http://127.0.0.1:4317"
    @State private var code = ""

    var body: some View {
        ViewThatFits(in: .vertical) {
            form
            ScrollView { form }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(WorkspaceStyle.canvas)
    }

    private var form: some View {
        VStack(alignment: .leading, spacing: 18) {
            BrandIcon(size: 54)
            VStack(alignment: .leading, spacing: 5) {
                Text("Connect to Arthegall")
                    .font(.system(size: 29, weight: .medium, design: .serif))
                Text("Enter your server address and pairing code to open your conversations.")
                    .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            VStack(alignment: .leading, spacing: 5) {
                Text("Server address").font(.headline)
                TextField("Server address", text: $address)
            }
            VStack(alignment: .leading, spacing: 5) {
                Text("Pairing code").font(.headline)
                SecureField("Pairing code", text: $code)
            }
            Button("Pair Mac") { Task { await model.pair(address: address, code: code) } }
                .buttonStyle(.borderedProminent).tint(WorkspaceStyle.pine)
                .keyboardShortcut(.defaultAction)
                .disabled(model.busy || code.isEmpty)
        }
        .controlSize(.large).frame(width: 330, alignment: .leading)
        .padding(28)
        .background(WorkspaceStyle.surface, in: RoundedRectangle(cornerRadius: 17))
        .overlay { RoundedRectangle(cornerRadius: 17).strokeBorder(WorkspaceStyle.hairline) }
        .padding(16)
    }
}
