import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { ExecutionContext, Outcome } from '../../../packages/contracts/src/index.js';

import { CreateAssignment, DateRange, Definition, ReportRequest, type AdminOperation, type UsageReport } from '../../../packages/contracts/src/reporting.js';

import { ScheduleItem, ChangeItem, ItemId, ListItems, type ScheduleOperation } from '../../../packages/contracts/src/scheduling.js';

export type Capabilities = {
  schedule?: (operation: ScheduleOperation) => Promise<unknown>;
  admin?: (operation: AdminOperation) => Promise<unknown>;
  usage?: (range: DateRange) => Promise<UsageReport>;
};
type Binding = Capabilities & {
  context: ExecutionContext;
  recordOutcome: (outcome: Outcome) => Promise<void>;
  expiresAt: number;
};
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const content = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });

/** Only the runner can create a binding; tool arguments cannot choose an identity. */
export async function startToolService() {
  const bindings = new Map<string, Binding>();
  const active = new Set<McpServer>();
  let authority = '';
  const server = createServer(async (request, response) => {
    if (request.headers.host !== authority || request.headers.origin !== undefined) {
      response.writeHead(403).end(); return;
    }
    if (request.url !== '/mcp') { response.writeHead(404).end(); return; }
    const header = request.headers.authorization;
    const key = header?.startsWith('Bearer ') ? digest(header.slice(7)) : '';
    const binding = bindings.get(key);
    if (!binding || binding.expiresAt <= Date.now()) { response.writeHead(401).end(); return; }
    if (request.method !== 'POST') { response.writeHead(405, { Allow: 'POST' }).end(); return; }
    const valid = () => {
      if (bindings.get(key) !== binding || binding.expiresAt <= Date.now()) throw new Error('Execution context expired');
    };
    const mcp = new McpServer({ name: 'arthegall-runner', version: '0.1.0' });
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    active.add(mcp);
    mcp.registerTool('read_context', {
      description: 'Read your current Arthegall identity, instructions, and recent conversation.',
      inputSchema: z.strictObject({}),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    }, async () => { valid(); return content(binding.context); });
    if (binding.schedule) {
      const invoke = (op: ScheduleOperation) => { valid(); return binding.schedule!(op).then(content); };
      mcp.registerTool('schedule_item', { inputSchema: ScheduleItem, description: 'Schedule an instruction in your current assignment. Use at with an offset, after in seconds, or cron with an IANA time zone. Missed recurring work defaults to latest.' },
        args => invoke({ tool: 'schedule_item', args }));
      mcp.registerTool('change_scheduled_item', { inputSchema: ChangeItem, description: 'Replace the instruction and timing for one active item in your assignment, including pending occurrences.' },
        args => invoke({ tool: 'change_scheduled_item', args }));
      mcp.registerTool('cancel_scheduled_item', { inputSchema: ItemId, description: 'Cancel one item and its pending occurrences in your assignment.' },
        args => invoke({ tool: 'cancel_scheduled_item', args }));
      mcp.registerTool('list_scheduled_items', { inputSchema: ListItems, description: 'List active follow-ups in your assignment. Pass nextAfterId as afterId for the next page.' },
        args => invoke({ tool: 'list_scheduled_items', args }));
    }
    if (binding.context.administrator && binding.admin) {
      const annotations = { destructiveHint: false, openWorldHint: false, idempotentHint: true };
      mcp.registerTool('create_reporting_assignment', { inputSchema: CreateAssignment, annotations,
        description: 'Create a named Codex agent, its DM and an on-demand usage assignment. Separate agent instructions from the assignment responsibility. Request user approval for access.' },
      async (args) => { valid(); return content(await binding.admin!({ tool: 'create_reporting_assignment', args })); });
      mcp.registerTool('revise_reporting_agent', { inputSchema: Definition, annotations, description: 'Revise the named reporting agent instructions. Authority stays scoped to its approved assignment.' },
      async (args) => { valid(); return content(await binding.admin!({ tool: 'revise_reporting_agent', args })); });
      mcp.registerTool('run_usage_report', { inputSchema: ReportRequest, annotations,
        description: 'Queue a report in the named reporting agent DM. Range is inclusive, Pacific time. Omit for yesterday.' },
      async (args) => { valid(); return content(await binding.admin!({ tool: 'run_usage_report', args })); });
    }
    if (binding.context.access && (binding.context.range || binding.context.scheduledItem) && binding.usage) {
      mcp.registerTool('read_usage', { inputSchema: DateRange, description: 'Read aggregate usage for the requested inclusive period. For a scheduled instruction, determine the period from its original due time.',
        annotations: { readOnlyHint: true, openWorldHint: false } }, async (range) => {
        valid();
        if (binding.context.range && (range.start !== binding.context.range.start || range.end !== binding.context.range.end)) throw new Error('Outside requested report period');
        return content(await binding.usage!(range));
      });
    }
    mcp.registerTool('report_outcome', {
      description: 'Record the explicit result of this run. Call once after completing the response or identifying a blocker.',
      inputSchema: binding.context.priorReport ? Outcome : Outcome.omit({ assignmentPreference: true }),
      annotations: { destructiveHint: false, openWorldHint: false },
    }, async (input) => {
      valid();
      const outcome = Outcome.parse(input);
      if (outcome.assignmentPreference && (!binding.context.priorReport || binding.context.range || outcome.status !== 'completed'))
        throw new Error('Assignment preferences can only be saved from a completed reply to a report');
      await binding.recordOutcome(outcome);
      return content({ recorded: true, runId: binding.context.runId });
    });
    const cleanup = async () => { active.delete(mcp); await mcp.close(); };
    response.once('close', () => { void cleanup(); });
    try {
      const parts: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += Buffer.byteLength(chunk);
        if (size > 128 * 1024) { response.writeHead(413).end(); return; }
        parts.push(Buffer.from(chunk));
      }
      let body: unknown;
      try { body = JSON.parse(Buffer.concat(parts).toString('utf8')); }
      catch { response.writeHead(400).end(); return; }
      valid();
      await mcp.connect(transport);
      await transport.handleRequest(request, response, body);
    } catch {
      if (!response.headersSent) response.writeHead(500).end();
      else response.end();
    }
  });
  server.requestTimeout = 30_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('MCP listener unavailable');
  authority = `127.0.0.1:${address.port}`;
  return {
    url: `http://${authority}/mcp`,
    bind(context: ExecutionContext, recordOutcome: Binding['recordOutcome'], ttlMs = 60 * 60 * 1000, capabilities: Capabilities = {}) {
      const token = randomBytes(32).toString('base64url');
      const key = digest(token);
      bindings.set(key, { ...capabilities, context: ExecutionContext.parse(context), recordOutcome, expiresAt: Date.now() + ttlMs });
      return { token, revoke: () => { bindings.delete(key); } };
    },
    async close() {
      bindings.clear();
      await Promise.all([...active].map((mcp) => mcp.close()));
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}
