import XCTest

final class PackageUpdateTests: XCTestCase {
    private struct Fixture: Decodable {
        let origin: String
        let bundle: String
        let dm: String
        let message: String
        let code: String
        let appURL: URL
        let updateURL: URL
        let updateBuild: Int
    }

    @MainActor func testPackagedAppKeepsPairingAndDraftAcrossUpdate() async throws {
        continueAfterFailure = false
        let path = try XCTUnwrap(ProcessInfo.processInfo.environment["ARTHEGALL_MAC_FIXTURE"])
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
        XCTAssertTrue(fixture.bundle.hasPrefix("org.arthegall.fixture."))
        XCTAssertEqual(Bundle(url: fixture.appURL)?.bundleIdentifier, fixture.bundle)

        let app = XCUIApplication(url: fixture.appURL)
        app.launch()
        let address = app.textFields["Server address"]
        XCTAssertTrue(address.waitForExistence(timeout: 15))
        address.click()
        address.typeKey("a", modifierFlags: .command)
        address.typeText(fixture.origin)
        let code = app.secureTextFields["Pairing code"]
        code.click()
        code.typeText(fixture.code)
        app.buttons["Pair Mac"].click()

        let reporter = app.descendants(matching: .any)["conversation-" + fixture.dm].firstMatch
        XCTAssertTrue(reporter.waitForExistence(timeout: 15))
        reporter.click()
        let savedReport = app.staticTexts["Synthetic report saved before the app update."].firstMatch
        XCTAssertTrue(savedReport.waitForExistence(timeout: 10))
        let reply = app.links["reply-to-" + fixture.message]
        XCTAssertTrue(reply.waitForExistence(timeout: 10))
        reply.click()
        let composer = app.descendants(matching: .any)["message-composer"].firstMatch
        let draft = "Synthetic draft to retain through an app update."
        composer.typeText(draft)
        XCTAssertEqual(composer.value as? String, draft)
        app.terminate()

        var request = URLRequest(url: fixture.updateURL)
        request.httpMethod = "POST"
        request.setValue(fixture.origin, forHTTPHeaderField: "Origin")
        let (data, response) = try await URLSession.shared.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        XCTAssertEqual(try JSONDecoder().decode([String: Int].self, from: data)["build"], fixture.updateBuild)

        app.launch()
        XCTAssertTrue(savedReport.waitForExistence(timeout: 15), "The updated app should reopen the same paired DM.")
        XCTAssertEqual(composer.value as? String, draft)
        XCTAssertTrue(app.links["Clear reply target"].exists)
        app.descendants(matching: .any)["connection-menu"].firstMatch.click()
        app.menuItems["Unpair This Mac…"].click()
        app.buttons["Unpair"].click()
        XCTAssertTrue(app.buttons["Pair Mac"].waitForExistence(timeout: 10))
    }
}
