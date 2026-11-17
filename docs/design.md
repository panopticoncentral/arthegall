# Arthegall product and architecture design

First design draft · November 16, 2026

Arthegall is a cross-platform control plane for agents. The user gives an assignment to a particular agent they know, follows the work when it interests them, and hears back when there is something to read or decide. The agent manages the providers and threads it uses to carry out the assignment.

## Agents and assignments

An **agent** has a persistent identity and an explicit definition. The definition describes its role, instructions, and authority. The same agent can own several assignments, work on several authorized machines, and take part in several conversations. Its identity survives a change of provider or the end of a provider session.

An **assignment** is a responsibility given to an agent. It might be a one-off investigation, a daily report, a regular ticket sweep, or periodic cleanup. A recurring assignment persists across individual runs. “Why did you skip this ticket on Tuesday?” concerns one run. “Leave documentation tickets for me from now on” changes how the agent carries out the sweep on future runs.

Assignments can draw on several forms of interaction over time. An investigation can start with a conversation and end with a written result. Cleanup can ordinarily run quietly and still have a history the user can inspect. A ticket sweep can ask for a decision on the day it encounters something unusual.

## DMs, channels, and collaboration

The working model is Slack-like. A direct message (DM) is a continuing conversation with a named agent. The reporting agent can deliver the daily report there, and the user can reply to ask about a particular figure. A ticket sweeper can DM a question. Channels organize work that benefits from a shared conversation. A long-running investigation can have a channel of its own. A separate inbox is optional.

In an investigation channel, the user or another agent can bring in a colleague by mentioning them. Ada can ask Rowan to investigate a build failure, share the failing run, and answer his follow-up questions directly. The user can read their exchange in the channel or intervene at any point. Ada can seek this help on her own authority. The system should retain enough context to connect the exchange to the investigation, even if Ada and Rowan use different providers.

## Memory

Agents have durable memory independent of any provider or thread. **Where a note applies** and **who can use it** are separate properties.

- Guidance given in the context of an assignment applies to that assignment by default. The instruction to skip documentation tickets carries over to tomorrow’s sweep. The user can explicitly give it broader project scope.
- Agents can keep personal notes, including what they have learned about a particular project or machine.
- Agents can also contribute shared knowledge for colleagues working on the relevant project or machine. If Rowan discovers where a test fixture lives on the build Mac, Ada should be able to use that fact when investigating a failure there.

## Agent setup and approval

A setup agent creates agents and maintains their definitions through conversation. The user can describe the colleague they want in ordinary language. Other agents can ask the setup agent for changes directly.

The setup agent must obtain the user’s approval before granting an agent a new tool, granting access to another machine, or changing a standing rule so the agent may act independently where it previously had to ask. A proposal should identify the agent, the requested change, and why it is needed. Permission to restart a service on one occasion applies to that action. Permission to restart it independently in the future changes the agent’s standing authority.

## Central server, user clients, and runners

| Component | Responsibility |
| --- | --- |
| Arthegall server | Owns the authoritative agent definitions, assignments, schedules, conversations, memories, and approvals. Coordinates work across runners. |
| User client | Connects to the server to show the user their agents, DMs, channels, and assignments. The user can follow the same conversation from different devices. |
| Runner | Runs on a machine that has providers, workspaces, or tools an assignment needs. Hosts provider sessions and threads, performs authorized local work, and reports progress and results to the server. |

For example, the user can DM Rowan to compare a Windows build with a Mac build. The server has one Rowan, one DM, and one assignment. With access to both machines, Rowan can use a local session on each and bring the findings back into that DM. If access to the Windows machine is new, the setup agent first brings the proposed grant to the user. A machine-specific memory can be stored centrally and still apply only to the machine it describes.

## Open questions

| Area | Decisions still to make |
| --- | --- |
| Hosting and connectivity | Where should the central server live, and what availability should the user expect? How do clients and runners reach and authenticate to it? Tailscale is one option. |
| Runner and provider selection | How does an agent choose a runner, provider, and session? What should it do when a required machine is asleep, disconnects mid-run, or misses a scheduled run? |
| Conversations and attention | How do replies in one DM stay attached to the right assignment? When does an investigation get a channel or subchannel? Are DMs, mentions, and unread state sufficient without an inbox? |
| Collaboration and ownership | When does a request for help become a separately tracked assignment? Who follows up, and who reports completion to the user? |
| Memory stewardship | When should an agent publish a discovery to shared memory? How should agents record its source, correct stale information, or resolve conflicting notes? |
| Setup and permissions | How is the initial setup agent defined? Which routine edits may it apply autonomously? How are one-time, assignment-limited, and standing approvals recorded, enforced, and revoked? |
| First release | Which user platforms, runner operating systems, and providers come first? Which representative assignment should demonstrate the complete experience? |
