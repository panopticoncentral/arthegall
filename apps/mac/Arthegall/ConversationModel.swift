import SwiftUI

@MainActor
final class ConversationModel: ObservableObject {
    @Published private(set) var pairing: Pairing?
    @Published private(set) var snapshot: Snapshot?
    @Published private(set) var local = LocalState()
    @Published private(set) var online = false
    @Published private(set) var busy = false
    @Published var problem: String?
    @Published var connectionStatus = "Connecting…"
    @Published private(set) var savingSettings = false
    @Published var settingsError: String?
    private let client = Client()

    init() {
        do {
            if let saved = try Credentials.load() {
                local = try LocalState.load(saved)
                pairing = saved
            }
        } catch { problem = error.localizedDescription }
    }

    var selected: String? {
        if let pending = local.pending { return pending.conversationId }
        if let id = local.selection, snapshot?.conversations.contains(where: { $0.id == id }) == true { return id }
        return snapshot?.conversations.first?.id
    }

    func pair(address: String, code: String) async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do {
            let result = try await client.pair(origin: Client.origin(address), code: code)
            try Credentials.save(result)
            local = LocalState()
            pairing = result
            problem = nil
        } catch { problem = error.localizedDescription }
    }

    private func forget() throws {
        if let pairing { try LocalState.remove(pairing) }
        try Credentials.remove()
        settingsError = nil
        snapshot = nil
        pairing = nil
        local = LocalState()
        online = false
        connectionStatus = "Connecting…"
    }

    func unpair() async {
        guard let pairing, !busy else { return }
        busy = true
        defer { busy = false }
        do {
            do { try await client.revoke(pairing) }
            catch let error as ClientError where error.status == 401 { }
            try forget()
            problem = nil
        } catch { problem = error.localizedDescription }
    }

    func follow() async {
        guard let current = pairing else { return }
        while !Task.isCancelled && current == pairing {
            do {
                let initial = try await client.snapshot(current)
                try Task.checkCancellation()
                guard current == pairing else { return }
                snapshot = initial
                online = true
                connectionStatus = "Connected"
                let socket = client.events(current, after: initial.cursor)
                try await withTaskCancellationHandler {
                    socket.resume()
                    defer { socket.cancel(with: .goingAway, reason: nil) }
                    while !Task.isCancelled {
                        let event = try await ClientEvent(frame: socket.receive())
                        if let snapshot, event.sequence <= snapshot.cursor { continue }
                        let next = try await client.snapshot(current)
                        try Task.checkCancellation()
                        guard current == pairing else { return }
                        if next.cursor >= (snapshot?.cursor ?? 0) { snapshot = next }
                    }
                } onCancel: { socket.cancel(with: .goingAway, reason: nil) }
            } catch {
                guard !Task.isCancelled, current == pairing else { return }
                online = false
                if let failure = error as? ClientError, failure.status == 401 {
                    do { try forget(); problem = "Pairing expired or was revoked. Enter a new pairing code." }
                    catch { problem = error.localizedDescription }
                    return
                }
                connectionStatus = error.localizedDescription
                try? await Task.sleep(for: .seconds(2))
            }
        }
    }

    func reportingSettings(for id: String) async throws -> ReportingSettings {
        guard let pairing else { throw CancellationError() }
        let result = try await client.reportingSettings(pairing, conversation: id)
        try Task.checkCancellation()
        guard self.pairing == pairing else { throw CancellationError() }
        return result
    }

    func runActivity(for id: String, before: Int? = nil) async throws -> RunActivityPage {
        guard let pairing else { throw CancellationError() }
        let result = try await client.runActivity(pairing, runId: id, before: before)
        try Task.checkCancellation()
        guard self.pairing == pairing else { throw CancellationError() }
        return result
    }

    @discardableResult
    func saveSetting<Body: Encodable & Sendable>(_ path: String, _ body: Body) async -> Bool {
        guard let pairing, online, snapshot?.settingsVersion == 1, !savingSettings else { return false }
        savingSettings = true
        settingsError = nil
        defer { savingSettings = false }
        var saved = false
        do {
            try await client.saveSetting(pairing, path: path, body: body)
            saved = true
        } catch {
            guard self.pairing == pairing else { return false }
            settingsError = error.localizedDescription
            // Another paired client may have resolved the request before this decision arrived.
            guard (error as? ClientError)?.status == 409 else { return false }
        }
        do {
            let latest = try await client.snapshot(pairing)
            guard self.pairing == pairing else { return false }
            if latest.cursor >= (snapshot?.cursor ?? 0) { snapshot = latest }
        } catch {
            if self.pairing == pairing && saved {
                settingsError = "Change saved. Could not refresh settings: " + error.localizedDescription
            }
        }
        return saved && self.pairing == pairing
    }

    func decideCommand(_ approval: Snapshot.CommandApproval, allow: Bool) async {
        guard snapshot?.commandApprovalsVersion == 1, snapshot?.recovery == nil,
              snapshot?.approvals?.contains(where: { $0.id == approval.id }) == true else { return }
        await saveSetting("approvals/" + approval.id, ["decision": allow ? "accept" : "decline"])
    }

    func setPinned(_ pinned: Bool, runID: String) async {
        guard snapshot?.recoveryVersion == 1, snapshot?.recovery == nil else { return }
        await saveSetting("runs/\(runID)/pin", ["pinned": pinned])
    }

    func recheckRunners() async {
        guard snapshot?.recoveryVersion == 1, snapshot?.recovery != nil else { return }
        await saveSetting("recovery/recheck", [String: String]())
    }

    func resumeDispatch() async {
        guard snapshot?.recoveryVersion == 1, snapshot?.recovery?.ready == true else { return }
        await saveSetting("recovery/resume", [String: String]())
    }

    @discardableResult
    private func update(_ change: (inout LocalState) -> Void) -> Bool {
        guard let pairing else { return false }
        var next = local
        change(&next)
        do { try next.save(pairing); local = next; return true }
        catch { problem = error.localizedDescription; return false }
    }

    func select(_ id: String?) {
        guard let id, local.pending == nil, local.selection != id else { return }
        update { $0.selection = id }
    }

    func edit(_ text: String, in id: String) {
        guard local.pending == nil else { return }
        update { $0.drafts[id] = text }
    }

    func reply(to message: Message, in id: String) {
        guard local.pending == nil, message.conversationId == id, message.evidence != nil else { return }
        update {
            var targets = $0.replyTargets ?? [:]
            targets[id] = message.id
            $0.replyTargets = targets
        }
    }

    func clearReply(in id: String) {
        guard local.pending == nil else { return }
        update { $0.replyTargets?.removeValue(forKey: id) }
    }

    func send() async {
        guard let pairing, let id = selected, online, !busy else { return }
        let text = (local.drafts[id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let command = local.pending ?? SendCommand(commandId: UUID(), conversationId: id, text: text,
                                                    replyTo: local.replyTargets?[id])
        guard !command.text.isEmpty, command.text.utf16.count <= 16_000,
              update({ $0.pending = command }) else { return }
        busy = true
        defer { busy = false }
        do {
            try await client.send(command, pairing)
            guard self.pairing == pairing else { return }
            if update({
                $0.pending = nil
                $0.drafts.removeValue(forKey: id)
                $0.replyTargets?.removeValue(forKey: id)
            }) { problem = nil }
        } catch {
            guard self.pairing == pairing else { return }
            problem = error.localizedDescription
            if let failure = error as? ClientError, [400, 409].contains(failure.status ?? 0) {
                update { $0.pending = nil }
            }
        }
    }
}
