import AppKit
import XCTest

final class ReportingTests: XCTestCase {
    struct Fixture: Decodable {
        let origin: String
        let code: String
        let bundle: String
        let adminDM: String
        let fixtureURL: URL
    }

    private struct FixtureResponse: Decodable {
        let id: String?
        let error: String?
    }

    @MainActor
    func testReportingAcrossRelaunches() async throws {
        continueAfterFailure = false
        let path = try XCTUnwrap(ProcessInfo.processInfo.environment["ARTHEGALL_MAC_FIXTURE"])
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
        XCTAssertTrue(fixture.bundle.hasPrefix("org.arthegall.fixture."))
        let app = XCUIApplication(bundleIdentifier: fixture.bundle)
        app.launch()
        let address = app.textFields["Server address"]
        XCTAssertTrue(address.waitForExistence(timeout: 10))
        address.click()
        address.typeKey("a", modifierFlags: .command)
        address.typeText(fixture.origin)
        let code = app.secureTextFields["Pairing code"]
        code.click()
        code.typeText(fixture.code)
        app.buttons["Pair Mac"].click()

        send("Create Rowan and run a usage report.", in: app)
        let reporterDM = try await fixtureID(["lookupRowan": true], fixture: fixture)
        openDM(reporterDM, name: "Rowan", in: app)
        reviewReportingAccess(in: app)
        let allowRun = app.buttons["Allow next run only"]
        XCTAssertTrue(allowRun.waitForExistence(timeout: 10))
        allowRun.click()
        app.buttons["Back to conversation"].click()
        XCTAssertTrue(app.staticTexts["Synthetic total: 33"].firstMatch.waitForExistence(timeout: 20))
        openDM(fixture.adminDM, name: "Administrator", in: app)
        send("Schedule Rowan's daily report at 8:00 AM Pacific.", in: app)
        openDM(reporterDM, name: "Rowan", in: app)
        reviewReportingAccess(in: app)
        let allowRecurring = app.buttons["Allow recurring reports"]
        XCTAssertTrue(allowRecurring.waitForExistence(timeout: 10))
        allowRecurring.click()
        XCTAssertTrue(app.buttons["Change schedule"].waitForExistence(timeout: 10))
        app.terminate()

        let first = try await fixtureID(["day": 15], fixture: fixture)
        app.launch()
        let firstTotal = app.staticTexts["Synthetic total: 34"].firstMatch
        XCTAssertTrue(firstTotal.waitForExistence(timeout: 15))
        let evidence = app.buttons["recorded-usage-" + first]
        XCTAssertTrue(evidence.waitForExistence(timeout: 10))
        XCTAssertTrue(evidence.label.contains("Recorded usage · 2020-06-14"))
        evidence.click()
        let coverage = NSPredicate(format: "label CONTAINS %@ OR value CONTAINS %@", "No local records", "No local records")
        let noRecords = app.staticTexts.matching(coverage).firstMatch
        XCTAssertTrue(noRecords.waitForExistence(timeout: 10), "The expanded report should show Claude coverage as ‘No local records’.")
        let firstLine = "America/Los_Angeles · Local runner records"
        verifyCopy(of: app.staticTexts[firstLine].firstMatch, expected: firstLine, in: app)
        evidence.click()
        let original = app.buttons["original-message-" + first]
        original.click()
        let source = app.staticTexts["original-report-source"].firstMatch
        XCTAssertTrue(source.waitForExistence(timeout: 10))
        XCTAssertEqual(source.value as? String, "Synthetic total: 34")
        verifyCopy(of: source, expected: "Synthetic total: 34", in: app)
        original.click()
        let reply = app.links["reply-to-" + first]
        XCTAssertTrue(reply.waitForExistence(timeout: 10))
        reply.click()
        XCTAssertTrue(app.links["Clear reply target"].waitForExistence(timeout: 10))
        let composer = app.textFields["message-composer"]
        let draft = "Put source coverage first from now on."
        composer.click()
        composer.typeText(draft)
        app.terminate()
        app.launch()
        XCTAssertTrue(composer.waitForExistence(timeout: 10))
        XCTAssertEqual(composer.value as? String, draft)
        XCTAssertTrue(app.links["Clear reply target"].exists)
        composer.typeKey(.return, modifierFlags: .command)
        XCTAssertTrue(app.buttons["Retry Send"].waitForExistence(timeout: 10))
        app.terminate()
        app.launch()
        let retry = app.buttons["Retry Send"]
        XCTAssertTrue(retry.waitForExistence(timeout: 10))
        retry.click()
        XCTAssertTrue(app.staticTexts["Saved your preference for the report with 34 tokens."].firstMatch.waitForExistence(timeout: 20))
        app.terminate()

        _ = try await fixtureID(["day": 16], fixture: fixture)
        app.launch()
        XCTAssertTrue(app.staticTexts["Source coverage: local records. Synthetic total: 35"].firstMatch.waitForExistence(timeout: 15))
        app.descendants(matching: .any)["connection-menu"].firstMatch.click()
        app.menuItems["Unpair This Mac…"].click()
        app.buttons["Unpair"].click()
        XCTAssertTrue(app.buttons["Pair Mac"].waitForExistence(timeout: 10))
    }

    @MainActor private func verifyCopy(of text: XCUIElement, expected: String, in app: XCUIApplication) {
        XCTAssertTrue(text.waitForExistence(timeout: 10))
        // Select inside the first word, even when the accessibility frame spans the row.
        text.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: 5, dy: text.frame.height / 2)).doubleClick()
        app.typeKey("a", modifierFlags: .command)
        let before = NSPasteboard.general.changeCount
        app.typeKey("c", modifierFlags: .command)
        XCTAssertNotEqual(NSPasteboard.general.changeCount, before, "Copy should write the selected report text.")
        XCTAssertEqual(NSPasteboard.general.string(forType: .string), expected)
    }

    @MainActor private func send(_ text: String, in app: XCUIApplication) {
        let composer = app.descendants(matching: .any)["message-composer"].firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 10))
        composer.click()
        composer.typeText(text)
        composer.typeKey(.return, modifierFlags: .command)
    }

    @MainActor private func openDM(_ id: String, name: String, in app: XCUIApplication) {
        let row = app.descendants(matching: .any)["conversation-" + id].firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 15), "The server has the \(name) DM, but the sidebar did not show its conversation row.")
        row.click()
    }

    @MainActor private func reviewReportingAccess(in app: XCUIApplication) {
        let review = app.buttons["Review reporting access"]
        XCTAssertTrue(review.waitForExistence(timeout: 15))
        review.click()
    }

    private func fixtureID<Body: Encodable>(_ body: Body, fixture: Fixture) async throws -> String {
        var request = URLRequest(url: fixture.fixtureURL)
        request.httpMethod = "POST"
        request.setValue(fixture.origin, forHTTPHeaderField: "Origin")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(body)
        let (data, response) = try await URLSession.shared.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        let result = try JSONDecoder().decode(FixtureResponse.self, from: data)
        guard status == 200, let id = result.id else {
            throw NSError(domain: "ReportingFixture", code: status, userInfo: [
                NSLocalizedDescriptionKey: result.error ?? "The reporting fixture did not return an ID."
            ])
        }
        return id
    }
}
