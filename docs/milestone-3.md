# Scheduled usage reports

In the reporter’s DM, ask “Send me the previous Pacific day’s usage every weekday at 5 PM Pacific.” The reporter creates a scheduled item in its assignment. To change the time, add another report, or cancel a follow-up, tell the reporter which item you mean. Open assignment settings to see its scheduled instructions and due times.

The reporter needs ordinary runner and usage access. Choose **Allow for this assignment** for ongoing work or **Allow next run only** for one run. Creating or changing a schedule grants no access. Upgrading removes active and pending schedules from the former daily-report workflow. Ask the reporter to recreate any you want.

Closing the Mac app leaves the server clock running. If the runner misses several occurrences, the default delivers the latest and records earlier skips. Ask for backfill to deliver each occurrence in order. The reporter interprets relative periods such as “yesterday” using the original due time. Closing the assignment cancels its outstanding items.

Saved reports render as Markdown, including tables. Expand **Original message text** to read the source or **Recorded usage** to inspect the underlying figures. Use **Reply to report** to select a particular result. Ask a question about the figures to use that report’s saved evidence. Reply “Put source coverage first from now on” to update the assignment’s presentation preferences. The reporter’s completed reply saves the new preference revision with its source run and selected report. Each scheduled dispatch uses the then-current agent definition, assignment instructions and preference revision in a fresh Codex thread and run directory.

## Verification

The server clock commits an occurrence and advances its timer together. When the runner can take work, the server claims the queued occurrence and creates its report run and dispatch in a single transaction. A scheduled item ID and due instant identify each occurrence. Repeated checks and reconnects reuse the existing dispatch and delivery receipts. The server saves usage evidence before it completes the DM message. If a provider turn is interrupted with an uncertain outcome, normal recovery records the blocked run for review.

The backend tests exercise a synthetic milestone 2 upgrade, both catch-up policies, calendar transitions, restarts and lost acknowledgments. The native API test pairs a client with an upgraded reporting installation, requests a schedule in the reporter’s DM, leaves the runner alone during deliveries, and checks provider threads, run directories, preference, evidence, messages, and receipts. Its optional live mode runs both agents through Codex with synthetic usage roots.

```sh
npm run build
ARTHEGALL_LIVE_CODEX=1 node --test dist/tests/native-scheduled.test.js
```

The [milestone 2 accounting rules](milestone-2.md#figures-and-coverage) continue to apply. Claude is a usage source and active-day coverage still needs verification.
