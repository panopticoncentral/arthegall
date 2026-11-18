import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { ExecutionContext, Outcome } from '../../../packages/contracts/src/index.js';

type Binding = {
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
    mcp.registerTool('report_outcome', {
      description: 'Record the explicit result of this run. Call once after completing the response or identifying a blocker.',
      inputSchema: Outcome,
      annotations: { destructiveHint: false, openWorldHint: false },
    }, async (outcome) => {
      valid();
      await binding.recordOutcome(Outcome.parse(outcome));
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
    bind(context: ExecutionContext, recordOutcome: Binding['recordOutcome'], ttlMs = 60 * 60 * 1000) {
      const token = randomBytes(32).toString('base64url');
      const key = digest(token);
      bindings.set(key, { context: ExecutionContext.parse(context), recordOutcome, expiresAt: Date.now() + ttlMs });
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
