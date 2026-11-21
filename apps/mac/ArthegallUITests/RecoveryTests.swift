import XCTest

final class RecoveryTests: XCTestCase {
    private struct Fixture: Decodable {
        let origin: String
        let bundle: String
        let code: String
        let dm: String
        let priorMessage: String
        let controller: URL
    }

    private struct Result: Decodable {
        let messageId: String?
        let error: String?
    }

    @MainActor func testRestoreFromPairedMac() async throws {
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
        let sidebar = app.descendants(matching: .any)["conversation-" + fixture.dm].firstMatch
        XCTAssertTrue(sidebar.waitForExistence(timeout: 10))
        sidebar.click()

        openRun(fixture.priorMessage, in: app)
        XCTAssertTrue(visibleText("Synthetic retained provider trace.", in: app).waitForExistence(timeout: 10))
        app.buttons["Pin run"].click()
        let unpin = app.buttons["Unpin run"]
        XCTAssertTrue(unpin.waitForExistence(timeout: 10))
        unpin.click()
        XCTAssertTrue(app.buttons["Pin run"].waitForExistence(timeout: 10))
        app.buttons["Done"].click()

        app.typeKey(",", modifierFlags: .command)
        let agents = app.buttons["Agents"]
        XCTAssertTrue(agents.waitForExistence(timeout: 10))
        agents.click()
        app.buttons["settings-agent-" + fixture.dm].click()
        let edit = app.buttons["Edit instructions"]
        XCTAssertTrue(edit.waitForExistence(timeout: 10))
        edit.click()
        let instructions = app.descendants(matching: .any)["agent-instructions"].firstMatch
        instructions.click()
        instructions.typeKey("a", modifierFlags: .command)
        instructions.typeText("Synthetic stale edit.")
        _ = try await advance("edit-from-second-client", fixture: fixture)
        XCTAssertTrue(visibleText("The agent definition has changed.", in: app).waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["Save revision"].isEnabled)
        app.buttons["Cancel"].click()
        XCTAssertTrue(visibleText("Synthetic instructions from the second client.", in: app).waitForExistence(timeout: 10))
        app.buttons["Back to conversation"].click()

        let report = try await advance("backup-and-deliver", fixture: fixture)
        let reportID = try XCTUnwrap(report.messageId)
        XCTAssertTrue(visibleText("Synthetic total: 34", in: app).waitForExistence(timeout: 10))
        openRun(reportID, in: app)
        app.buttons["Pin run"].click()
        XCTAssertTrue(app.buttons["Unpin run"].waitForExistence(timeout: 10))
        app.terminate()
        _ = try await advance("restore", fixture: fixture)
        app.launch()

        let review = app.buttons["Review recovery"]
        XCTAssertTrue(review.waitForExistence(timeout: 15), "The paired Mac should show the restore pause immediately after relaunch.")
        review.click()
        let resume = app.buttons["Resume dispatch"]
        XCTAssertTrue(resume.waitForExistence(timeout: 10))
        XCTAssertFalse(resume.isEnabled)
        XCTAssertTrue(visibleText("Waiting for reconnect", in: app).exists)
        _ = try await advance("connect-incomplete-runner", fixture: fixture)
        XCTAssertTrue(visibleText("Runner has no matching execution for this dispatch", in: app).waitForExistence(timeout: 10))
        XCTAssertFalse(resume.isEnabled)
        app.buttons["Check runners again"].click()
        let recovered = try await advance("connect-intact-runner", fixture: fixture)
        XCTAssertEqual(recovered.messageId, reportID)
        XCTAssertTrue(visibleText("All runner records agree", in: app).waitForExistence(timeout: 10))
        app.buttons["Back to conversation"].click()

        XCTAssertTrue(visibleText("Synthetic total: 34", in: app).waitForExistence(timeout: 10))
        openRun(reportID, in: app)
        XCTAssertTrue(app.buttons["Unpin run"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["Unpin run"].isEnabled)
        app.buttons["Done"].click()
        let evidence = app.disclosureTriangles["recorded-usage-" + reportID]
        XCTAssertTrue(evidence.waitForExistence(timeout: 10))
        clickChevron(evidence)
        XCTAssertTrue(visibleText("Total 34", in: app).waitForExistence(timeout: 10))
        clickChevron(evidence)
        let reply = app.links["reply-to-" + reportID]
        XCTAssertTrue(reply.waitForExistence(timeout: 10))
        reply.click()
        let composer = app.descendants(matching: .any)["message-composer"].firstMatch
        composer.typeText("Put source coverage first from now on.")
        app.buttons["Queue Message"].click()
        XCTAssertTrue(visibleText("Queued for runner", in: app).waitForExistence(timeout: 10))
        review.click()
        XCTAssertTrue(resume.waitForExistence(timeout: 10))
        XCTAssertTrue(resume.isEnabled)
        resume.click()
        XCTAssertTrue(resume.waitForNonExistence(timeout: 10))
        app.buttons["Back to conversation"].click()
        XCTAssertTrue(visibleText("Saved your preference.", in: app).waitForExistence(timeout: 20))

        _ = try await advance("prepare-cleanup", fixture: fixture)
        let transcript = app.scrollViews["conversation-transcript"]
        XCTAssertTrue(transcript.waitForExistence(timeout: 10))
        transcript.scroll(byDeltaX: 0, deltaY: 1_200)
        openRun(fixture.priorMessage, in: app)
        XCTAssertTrue(visibleText("Cleanup awaiting runner confirmation", in: app).waitForExistence(timeout: 10))
        _ = try await advance("finish-cleanup", fixture: fixture)
        XCTAssertTrue(visibleText("Detailed execution history pruned", in: app).waitForExistence(timeout: 10))
        app.buttons["Done"].click()

        app.descendants(matching: .any)["connection-menu"].firstMatch.click()
        app.menuItems["Unpair This Mac…"].click()
        app.buttons["Unpair"].click()
        XCTAssertTrue(app.buttons["Pair Mac"].waitForExistence(timeout: 10))
    }

    @MainActor private func visibleText(_ text: String, in app: XCUIApplication) -> XCUIElement {
        app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@ OR value CONTAINS %@", text, text)).firstMatch
    }

    @MainActor private func openRun(_ messageID: String, in app: XCUIApplication) {
        let link = app.links["run-details-" + messageID]
        XCTAssertTrue(link.waitForExistence(timeout: 10))
        link.click()
    }

    @MainActor private func clickChevron(_ disclosure: XCUIElement) {
        disclosure.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: 26, dy: 8)).click()
    }

    private func advance(_ action: String, fixture: Fixture) async throws -> Result {
        var request = URLRequest(url: fixture.controller.appendingPathComponent(action))
        request.httpMethod = "POST"
        let (data, response) = try await URLSession.shared.data(for: request)
        let result = try JSONDecoder().decode(Result.self, from: data)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200, result.error ?? action)
        return result
    }
}
