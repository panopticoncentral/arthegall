import XCTest

final class ReportingTests: XCTestCase {
    struct Fixture: Decodable {
        let origin: String
        let code: String
        let bundle: String
        let fixtureURL: URL
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
        openDM("Rowan", in: app)
        reviewReportingAccess(in: app)
        let allowRun = app.buttons["Allow next run only"]
        XCTAssertTrue(allowRun.waitForExistence(timeout: 10))
        allowRun.click()
        app.buttons["Back to conversation"].click()
        XCTAssertTrue(app.staticTexts["Synthetic total: 33"].firstMatch.waitForExistence(timeout: 20))
        openDM("Administrator", in: app)
        send("Schedule Rowan's daily report at 8:00 AM Pacific.", in: app)
        openDM("Rowan", in: app)
        reviewReportingAccess(in: app)
        let allowRecurring = app.buttons["Allow recurring reports"]
        XCTAssertTrue(allowRecurring.waitForExistence(timeout: 10))
        allowRecurring.click()
        XCTAssertTrue(app.buttons["Change schedule"].waitForExistence(timeout: 10))
        app.terminate()

        let first = try await deliver(15, fixture: fixture)
        app.launch()
        let firstTotal = app.staticTexts["Synthetic total: 34"].firstMatch
        XCTAssertTrue(firstTotal.waitForExistence(timeout: 15))
        let evidence = app.descendants(matching: .any).matching(identifier: "Recorded usage · 2020-06-14").firstMatch
        XCTAssertTrue(evidence.waitForExistence(timeout: 10))
        evidence.click()
        let noRecords = app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "No local records")).firstMatch
        XCTAssertTrue(noRecords.waitForExistence(timeout: 10))
        evidence.click()
        let original = app.descendants(matching: .any)["original-message-" + first].firstMatch
        original.click()
        XCTAssertTrue(app.descendants(matching: .any)["original-report-source"].firstMatch.waitForExistence(timeout: 10))
        original.click()
        let reply = app.buttons["reply-to-" + first]
        XCTAssertTrue(reply.waitForExistence(timeout: 10))
        reply.click()
        XCTAssertTrue(app.buttons["Clear reply target"].exists)
        send("Put source coverage first from now on.", in: app)
        XCTAssertTrue(app.buttons["Retry Send"].waitForExistence(timeout: 10))
        app.terminate()
        app.launch()
        let retry = app.buttons["Retry Send"]
        XCTAssertTrue(retry.waitForExistence(timeout: 10))
        retry.click()
        XCTAssertTrue(app.staticTexts["Saved your preference for the report with 34 tokens."].firstMatch.waitForExistence(timeout: 20))
        app.terminate()

        _ = try await deliver(16, fixture: fixture)
        app.launch()
        XCTAssertTrue(app.staticTexts["Source coverage: local records. Synthetic total: 35"].firstMatch.waitForExistence(timeout: 15))
        app.descendants(matching: .any)["connection-menu"].firstMatch.click()
        app.menuItems["Unpair This Mac…"].click()
        app.buttons["Unpair"].click()
        XCTAssertTrue(app.buttons["Pair Mac"].waitForExistence(timeout: 10))
    }

    @MainActor private func send(_ text: String, in app: XCUIApplication) {
        let composer = app.descendants(matching: .any)["message-composer"].firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 10))
        composer.click()
        composer.typeText(text)
        app.buttons["Send"].click()
    }

    @MainActor private func openDM(_ name: String, in app: XCUIApplication) {
        let row = app.descendants(matching: .any).matching(NSPredicate(format:
            "identifier BEGINSWITH %@ AND label CONTAINS %@", "conversation-", name)).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 15))
        row.click()
    }

    @MainActor private func reviewReportingAccess(in app: XCUIApplication) {
        let review = app.buttons["Review reporting access"]
        XCTAssertTrue(review.waitForExistence(timeout: 15))
        review.click()
    }

    private func deliver(_ day: Int, fixture: Fixture) async throws -> String {
        struct Delivery: Decodable { let messageId: String }
        var request = URLRequest(url: fixture.fixtureURL)
        request.httpMethod = "POST"
        request.setValue(fixture.origin, forHTTPHeaderField: "Origin")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(["day": day])
        let (data, response) = try await URLSession.shared.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        return try JSONDecoder().decode(Delivery.self, from: data).messageId
    }
}
