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
      reply({ thread: { id: 'synthetic-thread' }, model: 'synthetic' }); break;
    case 'thread/turns/list': reply({ data: [{ id: 'synthetic-turn', status: existsSync(join(root, 'completed')) ? 'completed' : 'interrupted' }] }); break;
    case 'turn/start': {
      if (mode() === 'hold-turn-response') break;
      reply({ turn: { id: 'synthetic-turn' } });
      if (mode() === 'expired-turn') {
        send({ method: 'turn/completed', params: { threadId: 'synthetic-thread', turn: { id: 'synthetic-turn', status: 'failed', error: { message: 'Authentication token expired (401)' } } } });
        break;
      }
      const mcp = config.mcp_servers.arthegall;
      const client = new Client({ name: 'synthetic-provider', version: '1' });
      await client.connect(new StreamableHTTPClientTransport(new URL(mcp.url), { requestInit: { headers: mcp.http_headers } }));
      await client.callTool({ name: 'read_context', arguments: {} });
      send({ method: 'item/agentMessage/delta', params: { threadId: 'synthetic-thread', delta: 'Synthetic durable result' } });
      await client.callTool({ name: 'report_outcome', arguments: { status: 'completed', message: 'Synthetic durable result' } });
      await client.close();
      writeFileSync(join(root, 'completed'), 'completed');
      if (mode() !== 'hold-completion') send({ method: 'turn/completed', params: { threadId: 'synthetic-thread', turn: { id: 'synthetic-turn', status: 'completed' } } });
      break;
    }
    default: throw new Error('Unexpected fixture request');
  }
})().catch(() => process.exit(1)); });
