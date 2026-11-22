# Daily usage reports

From the Administrator DM, ask “Have Rowan send yesterday’s usage report every morning at 8 AM Pacific.” Choose the time you want. The recurring access card identifies the existing assignment, local runner, read_usage tool, time, catch-up policy and duration. Select **Allow recurring reports** to activate it. An existing on-demand approval covers the original on-demand work. Scheduling requires its own decision.

The first eligible occurrence is the first due time at or after approval. The reporter DM shows the approved time. Closing Arthegall.app leaves the schedule active. Open the schedule beneath the reporter’s name and select **Change schedule** to change the time or enable backfill. You can also ask the Administrator. Review the proposal in Settings or the DM. The current schedule continues until the replacement is approved. Closing the assignment in **Assignment settings** ends future dispatches.

Each daily occurrence uses America/Los_Angeles and covers the calendar day before its due date. The spring clock gap moves a nonexistent time forward by the size of the gap. The autumn overlap uses the earlier instant. For a runner returning on Wednesday after missing Monday, Tuesday, and Wednesday mornings, default catch-up sends Tuesday’s usage and records two skips. Request “Backfill every missed daily report” to receive Sunday, Monday, and Tuesday separately under an approved backfill schedule.

Saved reports render as Markdown, including tables. Expand **Original message text** to read the source or **Recorded usage** to inspect the underlying figures. Use **Reply to report** to select a particular result. Ask a question about the figures to use that report’s saved evidence. Reply “Put source coverage first from now on” to update the assignment’s presentation preferences. The reporter’s completed reply saves the new preference revision with its source run and selected report. Each scheduled dispatch uses the then-current agent definition, assignment instructions and preference revision in a fresh Codex thread and run directory.

## Verification

The server commits each occurrence, run, pending dispatch and schedule cursor together when the connected runner can take work. A unique assignment and local due date identifies each occurrence. Repeated checks and reconnects reuse the existing dispatch and delivery receipts. The server saves usage evidence before it completes the DM message. If a provider turn is interrupted with an uncertain outcome, normal recovery records the blocked run for review.

The backend tests exercise a synthetic milestone 2 upgrade, both catch-up policies, calendar transitions, restarts and lost acknowledgments. The native API test pairs a client with an upgraded reporting installation, approves access, leaves the runner alone during deliveries, and checks provider threads, run directories, preference, evidence, messages, and receipts. Its optional live mode runs both agents through Codex with synthetic usage roots.

```sh
npm run build
ARTHEGALL_LIVE_CODEX=1 node --test dist/tests/native-scheduled.test.js
```

The [milestone 2 accounting rules](milestone-2.md#figures-and-coverage) continue to apply. Claude is a usage source and active-day coverage still needs verification.
