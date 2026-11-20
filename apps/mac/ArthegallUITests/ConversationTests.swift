import XCTest

final class ConversationTests: XCTestCase {
    @MainActor
    func testPairRetryAndReopen() async throws {
        continueAfterFailure = false
        struct Fixture: Decodable {
            let origin: String
            let code: String
            let bundle: String
            let adminDM: String
            let reportDM: String
            let closedURL: URL
        }
        let path = try XCTUnwrap(ProcessInfo.processInfo.environment["ARTHEGALL_MAC_FIXTURE"],
                                 "Run node tests/mac-conversation.mjs to start the isolated services.")
        let url = URL(fileURLWithPath: path)
        let directory = url.deletingLastPathComponent()
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
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
        let composer = app.descendants(matching: .any)["message-composer"].firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 10))
        app.descendants(matching: .any)["conversation-" + fixture.reportDM].firstMatch.click()
        XCTAssertTrue(app.staticTexts["Usage by provider"].waitForExistence(timeout: 5))
        let header = NSPredicate(format: "label CONTAINS %@ OR value CONTAINS %@", "Input tokens", "Input tokens")
        XCTAssertTrue(app.staticTexts.matching(header).firstMatch.exists)
        XCTAssertTrue(app.staticTexts["15,000 tokens across 2 providers"].exists)
        let transcript = XCTAttachment(screenshot: app.windows.firstMatch.screenshot())
        transcript.name = "Agent transcript"
        transcript.lifetime = .keepAlways
        add(transcript)
        app.descendants(matching: .any)["conversation-" + fixture.adminDM].firstMatch.click()
        composer.click()
        composer.typeText("/test approval")
        app.buttons["Send"].click()
        XCTAssertTrue(app.staticTexts["Synthetic response in progress…"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.buttons["Retry Send"].exists)
        app.terminate()
        app.launch()
        let retry = app.buttons["Retry Send"]
        XCTAssertTrue(retry.waitForExistence(timeout: 10))
        retry.click()
        XCTAssertTrue(app.buttons["Send"].waitForExistence(timeout: 10))
        app.terminate()
        var closed = URLRequest(url: fixture.closedURL)
        closed.httpMethod = "POST"
        closed.setValue(fixture.origin, forHTTPHeaderField: "Origin")
        let (_, response) = try await URLSession.shared.data(for: closed)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        let finished = directory.appendingPathComponent("finished")
        let outcome = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            FileManager.default.fileExists(atPath: finished.path)
        }, object: nil)
        await fulfillment(of: [outcome], timeout: 15)
        app.launch()
        XCTAssertTrue(app.staticTexts["Synthetic approval declined. No file operation was performed by this test provider."].waitForExistence(timeout: 10))
        // Selectable SwiftUI text may expose both a container and its text leaf.
        let prompts = app.staticTexts.matching(identifier: "/test approval").allElementsBoundByIndex
        XCTAssertEqual(prompts.filter { $0.staticTexts.count == 0 }.count, 1)
        app.descendants(matching: .any)["connection-menu"].firstMatch.click()
        app.menuItems["Unpair This Mac…"].click()
        app.buttons["Unpair"].click()
        XCTAssertTrue(app.buttons["Pair Mac"].waitForExistence(timeout: 10))
    }
}
