# On-demand usage reporting

In the **Administrator** DM, ask “Create a reporting agent named Rowan. Give Rowan an assignment to report local Codex and Claude usage, and run yesterday’s report.” You can also name an inclusive date range. The server resolves “yesterday” in America/Los_Angeles when the administrator queues the request.

The access card names the agent, assignment, local runner, and read-only usage tool. **Allow for this assignment** covers its on-demand runs and follow-ups until closure. **Allow next run only** binds the grant to the first dispatched run, including redelivery of that dispatch. A subsequent run needs another approval. **Decline** blocks work waiting for that request. A queued report can complete while the browser is closed.

Open **Rowan** under Direct messages. Expand **Recorded usage** for the saved aggregate evidence. **Reply to report** selects that report for the next question, even after newer reports arrive. An ordinary follow-up uses the most recent completed report in that assignment. Ask the administrator for another report or a revision to the agent’s instructions. In the reporter DM, **Connections → Close reporting assignment** ends access and preserves history. An in-flight run must finish first.

## Figures and coverage

Each source covers readable local records for the selected Pacific calendar days, including work outside Arthegall. Codex reads active and archived rollout JSONL. A response belongs to its earliest recorded day. Repeated copies count once. Input includes cached input and output includes reasoning output. Separate token-count events cross-check the response records. A disagreement marks coverage partial and the report retains the distinct-response sum.

Claude reads local Claude Code project JSONL, including nested sessions. Recognized assistant messages use the provider message ID for deduplication. Input combines ordinary input, cache creation and cache reads. Claude activity-day coverage still needs validation against an actual day of provider activity. The reader marks recognized Claude totals partial. [Anthropic’s input accounting](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)

An explicit zero token count is evidence for a zero in that response. An empty source yields unknown usage. Unreadable files, malformed usage or conflicting copies can limit coverage. The supported records do not establish billed dollars. Actual spend and the complete combined total are unknown. Only aggregates reach the reporting agent and the server.

## Persistence and execution

Both agents use Codex. A reporting definition has numbered revisions and one on-demand assignment in its own DM. The runner queues administrator operations before returning a result. The server checks the originating administrator dispatch and records the mutation, history and receipt in a transaction. The browser decides grants. The runner binds its MCP tools to the execution and checks the requested range. Report evidence uses the same ordered delivery queue as the final message. A successful report requires saved evidence and an explicit provider outcome. Shell access stays disabled in ordinary sessions.

The milestone 1 upgrade retains browser sessions, IDs, queued deliveries, messages and provider-thread mappings. Server and runner stores migrate independently. Before upgrading a deployed pair, stop both jobs, back up both private SQLite databases using the SQLite backup API, check integrity, and retain the prior package, job definitions and private configuration together for recovery.

Scheduling, catch-up, backfill and recurring presentation preferences belong to milestone 3.
