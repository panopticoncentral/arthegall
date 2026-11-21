import Foundation
import Security

enum Credentials {
    private static var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: Bundle.main.bundleIdentifier ?? "org.arthegall.mac",
         kSecAttrAccount as String: "paired-server"]
    }

    private static func check(_ status: OSStatus) throws {
        guard status == errSecSuccess else {
            throw ClientError(message: (SecCopyErrorMessageString(status, nil) as String?) ?? "Keychain error \(status)")
        }
    }

    static func load() throws -> Pairing? {
        var search = query
        search[kSecReturnData as String] = true
        var value: CFTypeRef?
        let status = SecItemCopyMatching(search as CFDictionary, &value)
        if status == errSecItemNotFound { return nil }
        try check(status)
        guard let data = value as? Data else { throw ClientError(message: "Unreadable Keychain entry.") }
        return try JSONDecoder().decode(Pairing.self, from: data)
    }

    static func save(_ pairing: Pairing) throws {
        let data = try JSONEncoder().encode(pairing)
        var item = query
        item[kSecValueData as String] = data
        item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        let status = SecItemAdd(item as CFDictionary, nil)
        if status == errSecDuplicateItem {
            try check(SecItemUpdate(query as CFDictionary, [kSecValueData: data] as CFDictionary))
        } else { try check(status) }
    }

    static func remove() throws {
        let status = SecItemDelete(query as CFDictionary)
        if status != errSecItemNotFound { try check(status) }
    }
}

struct LocalState: Codable {
    var selection: String?
    var drafts: [String: String] = [:]
    var replyTargets: [String: String]?
    var pending: SendCommand?

    private static func location(_ pairing: Pairing) throws -> URL {
        let base = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
                                                 appropriateFor: nil, create: true)
        let directory = base.appendingPathComponent(Bundle.main.bundleIdentifier ?? "org.arthegall.mac")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                               attributes: [.posixPermissions: 0o700])
        return directory.appendingPathComponent(pairing.session.sessionId.uuidString + ".json")
    }

    static func load(_ pairing: Pairing) throws -> LocalState {
        let url = try location(pairing)
        do { return try JSONDecoder().decode(Self.self, from: Data(contentsOf: url)) }
        catch let error as CocoaError where error.code == .fileReadNoSuchFile { return Self() }
    }

    static func remove(_ pairing: Pairing) throws {
        do { try FileManager.default.removeItem(at: location(pairing)) }
        catch let error as CocoaError where error.code == .fileNoSuchFile { }
    }

    func save(_ pairing: Pairing) throws {
        try JSONEncoder().encode(self).write(to: Self.location(pairing), options: .atomic)
    }
}
