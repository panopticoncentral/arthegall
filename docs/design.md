# Arthegall product and architecture design

Revised November 19, 2026 · First draft November 16, 2026

Arthegall is a cross-platform control plane for agents. The user gives an assignment to a particular agent they know, follows the work when it interests them, and hears back when there is something to read or decide. The agent manages the providers and threads it uses to carry out the assignment.

The [technical architecture and milestones](architecture.md) describe the first release's runtime, persistence, provider integration, recovery, and delivery checkpoints. The [installed-app migration plan](native-client-migration.md) ends with the Mac app as the sole user client and the browser client retired.

## Agents and assignments

An **agent** has a persistent identity and an explicit definition. The definition describes its role, instructions, and authority. The same agent can own several assignments, work on several authorized machines, and take part in several conversations. Its identity survives a change of provider or the end of a provider session.

An **assignment** is a responsibility given to an agent. It might be a one-off investigation, a daily report, a regular ticket sweep, or periodic cleanup. A recurring assignment persists across individual runs. “Why did you skip this ticket on Tuesday?” concerns one run. “Leave documentation tickets for me from now on” changes how the agent carries out the sweep on future runs.

Assignments can draw on several forms of interaction over time. An investigation can start with a conversation and end with a written result. Cleanup can ordinarily run quietly and still have a history the user can inspect. A ticket sweep can ask for a decision on the day it encounters something unusual.

An assignment can have any number of scheduled instructions. An agent can create, list, change or cancel its own assignment’s follow-ups. It can give an absolute time with an offset, a delay in seconds, or a cron expression with an IANA time zone. For example, a build check in five minutes and a weekday summary can belong to the same investigation. Closing the assignment cancels its outstanding items.

The server records each due occurrence even while the runner is busy or offline. The agent receives the original due time and instruction when the runner takes the work. A one-off stays queued across restarts. Each recurring item defaults to delivering the latest due occurrence and recording earlier skips. The agent can request backfill for an item to deliver every occurrence in order. For a daily report, this means an agent waking after three days normally sends one report covering the latest due reporting period.

## DMs, channels, and collaboration

The working model is Slack-like. A direct message (DM) is a continuing conversation with a named agent. Replies to an individual message inherit its assignment context. “Why was Tuesday’s count so high?” under a daily report asks about that run. “Include failed builds tomorrow” in the same place changes the recurring assignment. A new message in the main DM can name an assignment directly. If “pause that” could refer to two jobs, the agent asks which one.

Both users and agents can create channels. Ada can move a growing investigation from a DM into its own channel, carry over the question and findings so far, and link to it from the DM. Agent discretion about creating channels is provisional and should be revisited if it makes the sidebar hard to use. The user controls the hierarchy of nested folders. Agents can place channels in existing folders. A folder such as *Build Engineering / Windows* can organize several channels without having a conversation of its own.

Either the user or an agent can archive a channel when its work is done. Archived conversations remain searchable. Completing one assignment in a long-lived project channel can leave the channel open for the rest of the work.

In an investigation channel, the user or another agent can bring in a colleague by mentioning them. Ada can ask Rowan to investigate a build failure, share the failing run, and answer his follow-up questions directly. The user can read their exchange in the channel or intervene at any point. Ada can seek this help on her own authority. The system should retain enough context to connect the exchange to the investigation, even if Ada and Rowan use different providers.

The agents decide whether a reply is enough or a commitment deserves a linked assignment. If Rowan agrees to compare ten builds, he owns that comparison and reports back in the channel. Ada still owns the investigation and its conclusion.

When a channel investigation needs a user decision, the agent posts the question beside the findings and @mentions the user there. The user can answer in place, where the other agents can see the decision. On the next visit, a channel badge takes the user directly to the mention. The first release uses in-app mentions and defers system notifications. Reports and assignments already handled by DM stay in their existing conversation.

## Memory

Agents have durable memory independent of any provider or thread. **Where a note applies** and **who can use it** are separate properties.

- Guidance given in the context of an assignment applies to that assignment by default. The instruction to skip documentation tickets carries over to tomorrow’s sweep. The user can explicitly give it broader project scope.
- Personal notes may be project- or machine-specific. The user can inspect them, and their owner maintains them. Other agents learn from what the owner shares directly or publishes. A colleague can pass a correction back to the owner.
- Agents can publish and correct shared project or machine notes directly. If Ada verifies that a fixture moved to a new volume on the build Mac, she can update Rowan’s shared note. The note retains who changed it, why, and the run or other source supporting the correction.

When two observations appear to conflict, agents keep both along with the conditions and evidence behind each. If tests pass with different settings on different machines, the agents investigate and record where each observation applies. They involve the user only when a decision is needed, such as choosing which configuration the project should support.

## Agent setup and approval

A fresh installation starts with a dedicated setup agent. The user creates agents and revises their definitions by DMing this administrator in ordinary language. Other agents can request changes directly. The administrator can apply routine edits, such as asking Rowan to include log links in future build investigations, and keeps a change history the user can inspect. Operational assignments go to the agents it creates.

The setup agent must obtain the user’s approval before granting an agent a new tool, granting access to another machine, or changing a standing rule so the agent may act independently where it previously had to ask. A proposal should identify the agent, the requested change, and why it is needed. Permission to restart a service on one occasion applies to that action. Permission to restart it independently in the future changes the agent’s standing authority.

The default grant covers the named assignment, including retries and follow-up work, and expires when the assignment closes. For a recurring assignment, the request makes the duration explicit, for example “May Rowan use the Windows runner for every run of the morning ticket sweep?” The user can narrow a grant to one run or give standing access across assignments.

Approving a machine for an assignment lets the agent use any tool it already has on that machine for that assignment. Adding a tool still requires user approval. Standing rules for individual actions continue to apply, including any requirement to ask before restarting a service.

## Settings UI

The Settings destination gives the user a place to read the current configuration, see where each choice applies and make changes directly.

### Finding a setting

Open **Settings** from the conversation sidebar, regardless of which DM is selected. The navigation for an installation with a reporting agent named Rowan looks like this.

```text
Settings
├── System
│   ├── Connections
│   ├── Backups
│   └── Execution history
└── Agents
    └── Rowan
        ├── Definition and history
        ├── Tools and access
        └── Assignments
            └── Daily usage report
```

**Agent settings** in Rowan’s DM header opens the same Rowan page. Each saved report links to its assignment settings. The assignment page names its owner and links back to the conversation. On a narrow screen, each level occupies the main view, with a back link to its parent. Returning to the DM restores the selected conversation and draft.

| Scope | What the user finds there | Where a change takes effect |
| --- | --- | --- |
| **System** | Under **Connections**, inspect runners, provider sign-in status and Mac pairings. Under **Backups**, choose the destination and number of copies and inspect the last backup. Under **Execution history**, set how long to keep detailed run evidence. | Backup and retention policies cover this installation. Unpairing targets the current Mac app. A user can still pin an individual run from its details in the conversation. |
| **Agent** | Read the agent’s role and instructions, inspect definition revisions, and see preferred provider, model and effort. Review tools and machine access with the scope of each grant. Browse the agent’s assignments. | An instruction edit creates a definition revision for this agent’s future work. A grant used by just one assignment links to that assignment and shows its duration. |
| **Assignment** | Read the responsibility, instructions and saved preferences. Inspect the delivery conversation, schedule and time zone, missed-run policy, runner and approved tools. Review scheduled items or close the assignment here. | Changes apply to this responsibility. A recurring assignment carries them into future runs. Closing it ends future dispatch and access granted for that assignment. Its reports and conversation stay available. |

### How the scopes fit together

Suppose Rowan owns a daily usage report and a weekly build review. The system page shows whether the local runner is connected. Rowan’s page shows the instruction “Include links to supporting evidence,” which applies to both assignments. The daily report’s page shows “Put source coverage first,” its 8 AM Pacific schedule, and approval to read usage on the local runner for each occurrence. The weekly review has its own instructions and grants. Each run records the configuration used, so an earlier report can still be understood after a setting changes.

Chat and Settings use the same server-owned records. Asking the Administrator to revise Rowan’s instructions and saving those instructions on Rowan’s page both produce a definition revision visible in the same history. A preference saved from a reply to a report appears on the report’s assignment page, with a link to the reply that established it. The edit form names the affected agent or assignment before the user saves.

Ordinary edits take effect within their stated scope. Adding a tool, granting access to another machine, or expanding standing authority opens a proposal showing who needs what access, why and for how long. Changing a scheduled time in the agent’s DM uses the existing assignment permissions. A decision made from Settings or the DM resolves the same request in both places.

### First pass

Open **Settings → System** for connections, backups and retention. From a reporting DM, **Agent settings** opens its instructions and revision history. **Assignment settings** on a saved report opens the assignment, including its schedule, preferences, access decisions and closure action. The agent can manage multiple scheduled items through its DM.

This first pass uses the current local-runner reporting workflow. Selection among multiple runners or providers and editing model and effort preferences belong to the broader agent design. The existing [reporting workflow](milestone-2.md) and [daily schedule behavior](milestone-3.md) describe the reporting behavior.

## Central server, user clients, and runners

| Component | Responsibility |
| --- | --- |
| Arthegall server | Owns the authoritative agent definitions, assignments, schedules, conversations, memories, and approvals. Coordinates work across runners. |
| User client | Connects to the server to show the user their agents, DMs, channels, and assignments. The user can follow the same conversation from different devices. |
| Runner | Runs on a machine that has providers, workspaces, or tools an assignment needs. Hosts provider sessions and threads, performs authorized local work, and reports progress and results to the server. |

The user chooses a stable server host. A Mac mini can act as both server and runner. Clients and runners reach the server over a private network, including a LAN or tailnet. A VM reachable on that network is another deployment option. Public-facing deployments and their authentication requirements are deferred.

Each Mac app pairs using a short-lived server code and stores its credential in Keychain. The user can unpair the app and revoke its session.

Runners initiate the connection to the server and reconnect after sleep or an address change. A one-time pairing code enrolls a runner. Alternatively, the server can install and pair it over SSH. Runners fetch signed updates and restart after active work finishes. Local reinstallation or SSH deployment provides a repair path if a runner cannot start. Repair on the same machine should preserve pairing and agent grants. Normal operation and updates use the runner’s connection to the server. Once a machine is enrolled, the user can grant individual agents access to it.

An agent chooses an authorized runner with the workspace and tools its assignment needs. An explicit machine choice in the assignment takes precedence. Each agent has a preferred combination of provider, model, and effort level. It can choose another available combination to suit the task. Each provider session uses the workspace and tools on the runner that hosts it. Run history identifies the runner and configuration used.

For example, the user can DM Rowan to compare a Windows build with a Mac build. The server has one Rowan, one DM, and one assignment. With access to both machines, Rowan can use a local session on each and bring the findings back into that DM. If access to the Windows machine is new, the setup agent first brings the proposed grant to the user. A machine-specific memory can be stored centrally and still apply only to the machine it describes.

### Disconnected runners and revocation

A runner that loses contact with the server continues work within its existing approvals and waits at any step that needs a new one. It keeps results locally and reports them to the original assignment when it reconnects. Meanwhile, the server marks the runner disconnected and the outcome unknown. It holds off on dispatching a duplicate run because the runner may already have performed the action.

If the user revokes access, the server immediately blocks new dispatches that depend on that grant. The UI shows the revocation as pending runner acknowledgment while the runner is offline. On reconnect, the runner applies the revocation before taking another step that requires the grant, acknowledges it, and reports what it did while disconnected.

## First release and daily usage report

Arthegall.app is the user client. From the setup agent’s DM, the user asks for a reporting agent with a recurring assignment. “Every morning, DM me yesterday’s Codex and Claude token usage and spend.” Both agents use Codex for execution. Claude is a reporting source in this release and can become an execution provider later. The assignment runs on a single Mac runner and delivers to the DM even when the Mac app is closed.

The report covers the previous calendar day in the user’s time zone and reads the two apps’ own records on that machine, including sessions started outside Arthegall. Each app gets its own entry. Count usage recorded during the day even when the session began earlier. Show actual dollar spend where the app supplies it. Distinguish an unavailable figure or a missing source from a verified zero, and label any partial total with its coverage.

### What the local records support

A read-only feasibility check established the following coverage for one reporting day.

| Source | What the report can show |
| --- | --- |
| Codex | Input, output, and total tokens from distinct, timestamped response records. Cached input and reasoning output are available as subtotals already included in input and output. Actual spend was unavailable in the inspected records. |
| Claude | “No local usage records found” when the runner has no session data for the period. Both token usage and spend are unknown in that case. Coverage on a day with recorded activity still needs verification. |

For Codex, summing each response once within the local-day window matched the app’s separate token-count events. Those events provide a cross-check. Adding them to the response records would count the same usage twice. With the coverage above, the report can show a Codex token total and must leave combined usage and actual spend unknown.

## Open questions

1. **Channel creation.** In practice, do agents create too many channels for the sidebar to stay useful?
2. **Claude report coverage.** On a day with recorded Claude activity, what token usage and actual spend, if any, can the daily report establish from its local records?
