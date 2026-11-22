import Foundation

struct BackupStatus: Decodable {
    let enabled: Bool
    let destination: String
    let keep: Int
    let running: Bool
    let nextDue: Double?
    let lastSuccess: Double?
    let lastPath: String?
    let error: String?
    let timeZone: String
}

struct ScheduledItem: Decodable, Identifiable {
    let id: String
    let conversationId: String
    let instruction: String
    let nextDue: Double?
    let backfill: Int
    let when: Timing

    struct Timing: Decodable {
        let expression: String?
        let timeZone: String?
    }
}

struct AccessRequest: Decodable, Identifiable {
    let id: String
    let name: String
    let conversationId: String
    // Servers predating native Settings omit the grant's scope identifiers.
    let assignmentId: String?
    let runnerId: String?
}

struct ReportingSettings: Decodable {
    let assignmentInstructions: String
    let instructions: String
    let revision: Int
    let history: [Revision]
    let preference: Preference?
    let access: [Grant]

    struct Revision: Decodable {
        let revision: Int
        let instructions: String
    }

    struct Preference: Decodable {
        let instructions: String
        let messageId: String
    }

    struct Grant: Decodable {
        let duration: String
        let usedBy: String?
    }
}

struct BackupChange: Encodable {
    let destination: String
    let keep: Int
    let enabled: Bool
}

struct DefinitionChange: Encodable {
    let revision: Int
    var instructions: String
}
