import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { z } from 'zod';

const Frame = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.object({ code: z.number(), message: z.string() }).optional(),
});
export type Notification = { method: string; params: unknown };
type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

/** Newline JSON-RPC, with bounded frames and no automatic replay of requests. */
export class CodexRpc {
  readonly child: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private pending = new Map<number, Pending>();
  private listeners = new Set<(event: Notification) => void>();
  private failures = new Set<(error: Error) => void>();
  private buffer = '';
  private failure: Error | undefined;
  private closed: Promise<void>;
  onRequest: (method: string, params: unknown) => Promise<unknown> = async () => {
    throw new Error('Unsupported provider request');
  };

  constructor(command: string, args: string[], cwd: string, env = process.env) {
    this.child = spawn(command, args, { cwd, env, stdio: 'pipe', windowsHide: true });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (data: string) => this.receive(data));
    // Provider stderr may contain credentials, paths, or conversation data.
    // Drain it without putting it in application logs.
    this.child.stderr.resume();
    this.child.stdin.on('error', () => this.fail(new Error('Provider input closed')));
    this.child.on('error', () => this.fail(new Error('Could not start Codex app-server')));
    this.closed = new Promise((resolve) => this.child.once('close', () => {
      this.fail(new Error('Codex app-server exited; reconcile before retrying'));
      resolve();
    }));
  }

  async initialize() {
    const result = await this.request('initialize', {
      clientInfo: { name: 'arthegall', title: 'Arthegall', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    });
    this.send({ method: 'initialized', params: {} });
    return result;
  }

  subscribe(listener: (event: Notification) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  waitFor(predicate: (event: Notification) => boolean, timeoutMs = 120_000): Promise<Notification> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.listeners.delete(listener);
        this.failures.delete(failed);
      };
      const failed = (error: Error) => { cleanup(); reject(error); };
      const listener = (event: Notification) => {
        if (predicate(event)) { cleanup(); resolve(event); }
      };
      const timer = setTimeout(() => failed(new Error('Provider event timed out')), timeoutMs);
      this.listeners.add(listener);
      this.failures.add(failed);
    });
  }

  request(method: string, params: unknown, timeoutMs = 30_000): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex ${method} timed out; outcome may be unknown`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  private send(value: unknown) {
    if (!this.failure) this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  private receive(data: string) {
    this.buffer += data;
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (Buffer.byteLength(line) > 8 * 1024 * 1024) {
        this.fail(new Error('Provider frame exceeds limit')); return;
      }
      try {
        const frame = Frame.parse(JSON.parse(line));
        if (frame.method !== undefined) {
          if (frame.id !== undefined) {
            void this.onRequest(frame.method, frame.params).then(
              (result) => this.send({ id: frame.id, result }),
              () => this.send({ id: frame.id, error: { code: -32603, message: 'Request denied by runner' } }),
            );
          } else {
            for (const listener of this.listeners) listener({ method: frame.method, params: frame.params });
          }
        } else if (typeof frame.id === 'number') {
          const request = this.pending.get(frame.id);
          if (!request) continue; // Late response after timeout. Never replay automatically.
          this.pending.delete(frame.id);
          clearTimeout(request.timer);
          if (frame.error) request.reject(new Error(`Codex error ${frame.error.code}: ${frame.error.message}`));
          else if ('result' in frame) request.resolve(frame.result);
          else request.reject(new Error('Invalid provider response'));
        } else throw new Error('Invalid provider frame');
      } catch {
        this.fail(new Error('Invalid provider frame or notification handler failure'));
        return;
      }
    }
    if (Buffer.byteLength(this.buffer) > 8 * 1024 * 1024) this.fail(new Error('Provider frame exceeds limit'));
  }

  private fail(error: Error) {
    if (this.failure) return;
    this.failure = error;
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    this.pending.clear();
    for (const listener of this.failures) listener(error);
    this.listeners.clear();
    this.child.kill();
  }

  async close(signal: NodeJS.Signals = 'SIGTERM') {
    this.child.kill(signal);
    const timeout = setTimeout(() => this.child.kill('SIGKILL'), 2_000);
    try { await this.closed; } finally { clearTimeout(timeout); }
  }
}
