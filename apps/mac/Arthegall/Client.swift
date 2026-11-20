import Foundation

struct AppSession: Codable, Equatable {
    let version: Int
    let sessionId: UUID
    let token: String
}

struct Pairing: Codable, Equatable {
    let origin: URL
    let session: AppSession
}

struct Conversation: Decodable, Identifiable {
    let id: String
    let name: String
    let closed: Int
    let administrator: Int?
}

struct Message: Decodable, Identifiable {
    let id: String
    let conversationId: String
    let author: String
    let text: String
    let state: String
    let requestedReport: Int?
}

struct Snapshot: Decodable {
    let cursor: Int
    let conversations: [Conversation]
    let messages: [Message]
    let runnerConnected: Bool
    let runs: [RunSummary]?

    struct RunSummary: Decodable {
        let messageId: String
        let state: String
    }
}

struct ClientEvent: Decodable {
    let type: String
    let sequence: Int

    init(frame: URLSessionWebSocketTask.Message) throws {
        let data: Data
        switch frame {
        case .string(let text): data = Data(text.utf8)
        case .data(let bytes): data = bytes
        @unknown default: throw ClientError(message: "Unsupported event format.")
        }
        self = try JSONDecoder().decode(Self.self, from: data)
        guard type == "event" else { throw ClientError(message: "Unsupported server event.") }
    }
}

struct SendCommand: Codable {
    let commandId: UUID
    let conversationId: String
    let text: String
    var replyTo: String?
}

struct ClientError: LocalizedError {
    let message: String
    var status: Int?
    var errorDescription: String? { message }
}

private final class RedirectPolicy: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

final class Client {
    private let session: URLSession
    init() {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpShouldSetCookies = false
        configuration.httpCookieStorage = nil
        configuration.urlCredentialStorage = nil
        configuration.urlCache = nil
        session = URLSession(configuration: configuration, delegate: RedirectPolicy(), delegateQueue: nil)
    }
    deinit { session.invalidateAndCancel() }

    static func origin(_ input: String) throws -> URL {
        guard var parts = URLComponents(string: input.trimmingCharacters(in: .whitespacesAndNewlines)),
              let host = parts.host, !host.isEmpty, parts.user == nil, parts.password == nil,
              parts.query == nil, parts.fragment == nil, ["", "/"].contains(parts.path),
              parts.scheme == "https" || (parts.scheme == "http" && ["localhost", "127.0.0.1", "[::1]"].contains(host)),
              parts.port.map({ (1...65535).contains($0) }) ?? true else {
            throw ClientError(message: "Enter an HTTPS server address or a local loopback HTTP address.")
        }
        parts.path = ""
        guard let url = parts.url else { throw ClientError(message: "Invalid server address.") }
        return url
    }

    private func request(_ origin: URL, _ path: String, token: String? = nil) -> URLRequest {
        var request = URLRequest(url: origin.appendingPathComponent("client/v1/" + path))
        request.setValue("1", forHTTPHeaderField: "X-Arthegall-Client")
        if let token { request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization") }
        return request
    }

    private func post<Body: Encodable>(_ request: URLRequest, _ body: Body) throws -> URLRequest {
        var request = request
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(body)
        return request
    }

    private func load<T: Decodable>(_ request: URLRequest, as: T.Type) async throws -> T {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw ClientError(message: "Invalid server response.") }
        guard (200..<300).contains(http.statusCode) else {
            if http.statusCode == 404 { throw ClientError(message: "This server does not support Mac client protocol v1.", status: 404) }
            let problem = try? JSONDecoder().decode([String: String].self, from: data)
            throw ClientError(message: problem?["error"] ?? "Server returned HTTP \(http.statusCode).", status: http.statusCode)
        }
        return try JSONDecoder().decode(T.self, from: data)
    }

    func pair(origin: URL, code: String) async throws -> Pairing {
        let credentials = try await load(post(request(origin, "pair"), ["code": code]), as: AppSession.self)
        guard credentials.version == 1 else { throw ClientError(message: "Unsupported server protocol.") }
        return Pairing(origin: origin, session: credentials)
    }

    func snapshot(_ pairing: Pairing) async throws -> Snapshot {
        try await load(request(pairing.origin, "snapshot", token: pairing.session.token), as: Snapshot.self)
    }

    func send(_ command: SendCommand, _ pairing: Pairing) async throws {
        struct Receipt: Decodable { let runId: UUID }
        _ = try await load(post(request(pairing.origin, "messages", token: pairing.session.token), command), as: Receipt.self)
    }

    func revoke(_ pairing: Pairing) async throws {
        _ = try await load(post(request(pairing.origin, "revoke", token: pairing.session.token), [String:String]()), as: [String: Bool].self)
    }

    func events(_ pairing: Pairing, after cursor: Int) -> URLSessionWebSocketTask {
        var request = request(pairing.origin, "events", token: pairing.session.token)
        var parts = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!
        parts.scheme = parts.scheme == "https" ? "wss" : "ws"
        parts.queryItems = [URLQueryItem(name: "after", value: String(cursor))]
        request.url = parts.url
        return session.webSocketTask(with: request)
    }
}
