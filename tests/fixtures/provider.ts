import { yesterday } from '../../packages/contracts/src/reporting.js';
// Synthetic JSON-RPC provider for process-crash/authentication tests; no model calls.
import { createInterface } from 'node:readline';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const root = process.argv[2]!;
const mode = () => existsSync(join(root, 'mode')) ? readFileSync(join(root, 'mode'), 'utf8') : 'complete';
const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
let config: { mcp_servers: { arthegall: { url: string; http_headers: Record<string, string> } } };
const threadId = ['reporting', 'scheduled', 'mac-reporting'].includes(mode()) ? 'synthetic-' + process.cwd().split(/[\\/]/).at(-1) : 'synthetic-thread';
const lines = createInterface({ input: process.stdin });
process.stdin.on('end', () => process.exit(0));
process.stdout.on('error', () => process.exit(0));
lines.on('line', (line) => { void (async () => {
  const frame = JSON.parse(line);
  if (!frame.method || frame.id === undefined) return;
  appendFileSync(join(root, 'calls'), `${frame.method}\n`);
  const reply = (result: unknown) => send({ id: frame.id, result });
  switch (frame.method) {
    case 'initialize': reply({}); break;
    case 'account/read':
      if (mode() !== 'hold-account') reply({ account: mode() === 'signed-out' ? null : { type: 'synthetic' } });
      break;
    case 'config/read': reply({ config: {} }); break;
    case 'model/list': reply({ data: [{ model: 'synthetic', isDefault: true, defaultReasoningEffort: 'low' }] }); break;
    case 'thread/start': case 'thread/resume':
      config = frame.params.config;
      reply({ thread: { id: threadId }, model: 'synthetic' }); break;
    case 'thread/turns/list': reply({ data: [{ id: 'synthetic-turn', status: existsSync(join(root, 'completed')) ? 'completed' : 'interrupted' }] }); break;
    case 'turn/start': {
      if (mode() === 'hold-turn-response') break;
      reply({ turn: { id: 'synthetic-turn' } });
      if (mode() === 'expired-turn') {
        send({ method: 'turn/completed', params: { threadId, turn: { id: 'synthetic-turn', status: 'failed', error: { message: 'Authentication token expired (401)' } } } });
        break;
      }
      const mcp = config.mcp_servers.arthegall;
      const client = new Client({ name: 'synthetic-provider', version: '1' });
      await client.connect(new StreamableHTTPClientTransport(new URL(mcp.url), { requestInit: { headers: mcp.http_headers } }));
      const call = async (name: string, args: Record<string, unknown>) => {
        const result = await client.callTool({ name, arguments: args });
        if (result.isError) throw new Error('Synthetic tool failed');
        return JSON.parse((result.content as { text: string }[])[0]!.text);
      };
      const context = await call('read_context', {});
      let message = 'Synthetic durable result';
      let assignmentPreference: string | undefined;
      if (['scheduled', 'mac-reporting'].includes(mode())) {
        if (context.administrator) {
          if (mode() === 'mac-reporting' && context.messages.at(-1)?.text.startsWith('Create')) {
            await call('create_reporting_assignment', { name: 'Rowan', instructions: 'Report usage' });
            await call('run_usage_report', { name: 'Rowan', range: { start: '2020-06-13', end: '2020-06-13' } });
          }
        } else if (context.messages.at(-1)?.text.startsWith('Schedule')) {
          await call('schedule_item', { instruction: 'Report usage for the previous Pacific calendar day.',
            when: { kind: 'cron', expression: '0 8 * * *', timeZone: 'America/Los_Angeles' } });
          message = 'Scheduled daily usage';
        } else if (context.range || context.scheduledItem) {
          appendFileSync(join(root,'scheduled-executions'),context.runId + '\n');
          const report = await call('read_usage', context.range ?? yesterday(new Date(context.scheduledItem.dueAt)));
          message = (context.preference ? 'Source coverage: local records. ' : '') + 'Synthetic total: ' + report.codex.total;
        } else {
          assignmentPreference = 'Put source coverage first.';
          message = mode() === 'mac-reporting' ? `Saved your preference for the report with ${context.priorReport.codex.total} tokens.` : 'Saved your preference.';
        }
      }
      if (mode() === 'followups') {
        if (context.scheduledItem) {
          appendFileSync(join(root, 'wakeups'), JSON.stringify({ wake: context.scheduledItem, run: context.runId,
            instruction: context.messages.at(-1).text, access: context.access?.duration }) + '\n');
        } else {
          const check = await call('schedule_item', { instruction: 'Check the build', when: { kind: 'after', seconds: 300 } });
          const summary = await call('schedule_item', { instruction: 'Draft summary', when: { kind: 'cron', expression: '0 16 * * MON-FRI', timeZone: 'America/Los_Angeles' } });
          await call('change_scheduled_item', { id: summary.id, instruction: 'Send weekday summary', when: { kind: 'cron', expression: '0 17 * * MON-FRI', timeZone: 'America/Los_Angeles' } });
          const ticket = await call('schedule_item', { instruction: 'Check ticket', when: { kind: 'at', at: '2020-06-15T15:10:00Z' } });
          await call('cancel_scheduled_item', { id: ticket.id });
          const list = await call('list_scheduled_items', {});
          message = JSON.stringify({ check, summary, items: list.items });
        }
      }
      if (mode() === 'reporting') {
        if (context.administrator) {
          await call('create_reporting_assignment', { name: 'Rowan', instructions: 'Report usage' });
          await call('run_usage_report', { name: 'Rowan', range: { start: '2020-06-15', end: '2020-06-15' } });
        } else if (context.range) {
          const report = await call('read_usage', context.range);
          message = 'Synthetic total: ' + report.codex.total;
        } else message = 'Synthetic cached input: ' + context.priorReport.codex.cachedInput;
      }
      send({ method: 'item/agentMessage/delta', params: { threadId, delta: 'Synthetic durable result' } });
      await client.callTool({ name: 'report_outcome', arguments: { status: 'completed', message, ...(assignmentPreference ? { assignmentPreference } : {}) } });
      await client.close();
      writeFileSync(join(root, 'completed'), 'completed');
      if (mode() !== 'hold-completion') send({ method: 'turn/completed', params: { threadId, turn: { id: 'synthetic-turn', status: 'completed' } } });
      break;
    }
    default: throw new Error('Unexpected fixture request');
  }
})().catch(() => process.exit(1)); });
