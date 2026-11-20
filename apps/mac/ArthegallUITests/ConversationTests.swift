import XCTest

final class ConversationTests: XCTestCase {
    @MainActor
    func testPairRetryAndReopen() throws {
        continueAfterFailure = false
        struct Fixture: Decodable { let origin: String; let code: String; let bundle: String }
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
        try Data().write(to: directory.appendingPathComponent("closed"))
        let finished = directory.appendingPathComponent("finished")
        let outcome = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            FileManager.default.fileExists(atPath: finished.path)
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [outcome], timeout: 15), .completed)
        app.launch()
        XCTAssertTrue(app.staticTexts["Synthetic approval declined. No file operation was performed by this test provider."].waitForExistence(timeout: 10))
        XCTAssertEqual(app.staticTexts.matching(identifier: "/test approval").count, 1)
        app.buttons["connection-menu"].click()
        app.menuItems["Unpair This Mac…"].click()
        app.buttons["Unpair"].click()
        XCTAssertTrue(app.buttons["Pair Mac"].waitForExistence(timeout: 10))
    }
}
