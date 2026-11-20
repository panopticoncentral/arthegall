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

struct ReportSchedule: Decodable, Identifiable {
    let id: String
    let assignmentId: String
    let runnerId: String
    let conversationId: String
    let name: String
    let time: String
    let backfill: Int
    let state: String
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

struct ScheduleChange: Encodable {
    let activeId: String?
    var time: String
    var backfill: Bool

    enum CodingKeys: String, CodingKey { case activeId, time, backfill }

    func encode(to encoder: Encoder) throws {
        var fields = encoder.container(keyedBy: CodingKeys.self)
        // The server compares this explicit null with the current active schedule.
        try fields.encode(activeId, forKey: .activeId)
        try fields.encode(time, forKey: .time)
        try fields.encode(backfill, forKey: .backfill)
    }
}
