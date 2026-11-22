import { availablePort } from './helpers/port.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import WebSocket from 'ws';
import { NativeTestClient, pairNative, setupCode, waitFor, waitForServer } from './helpers/native-client.js';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer as createHttpsServer } from 'node:https';
import { request as httpRequest } from 'node:http';
import { connect } from 'node:net';

test('trusted HTTPS reverse proxy carries native pairing and both WebSocket routes', { skip: process.platform === 'win32' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'arthegall-https-'));
  const key = join(root, 'key.pem'), certificate = join(root, 'certificate.pem');
  // Trust the ephemeral certificate in this test process and its runner, without disabling TLS validation.
  const certificateConfig = join(root, 'certificate.cnf');
  writeFileSync(certificateConfig, `[req]
distinguished_name = name
prompt = no
x509_extensions = extensions
[name]
CN = localhost
[extensions]
subjectAltName = DNS:localhost,IP:127.0.0.1
basicConstraints = critical,CA:TRUE
`);
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', certificate, '-days', '1',
    '-config', certificateConfig], { stdio: 'ignore' });
  const backendPort = await availablePort();
  const proxy = createHttpsServer({ key: readFileSync(key), cert: readFileSync(certificate) }, (request, response) => {
    const upstream = httpRequest({ host: '127.0.0.1', port: backendPort, path: request.url, method: request.method, headers: request.headers }, (result) => {
      response.writeHead(result.statusCode ?? 502, result.headers); result.pipe(response);
    });
    upstream.on('error', () => { response.writeHead(502).end(); });
    request.pipe(upstream);
  });
  proxy.on('upgrade', (request, socket, head) => {
    const upstream = connect(backendPort, '127.0.0.1', () => {
      upstream.write(`${request.method} ${request.url} HTTP/1.1\r\n${Object.entries(request.headers).map(([name, value]) => `${name}: ${value}`).join('\r\n')}\r\n\r\n`);
      upstream.write(head); upstream.pipe(socket); socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy());
    socket.on('close', () => upstream.destroy()); upstream.on('close', () => socket.destroy());
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const port = (proxy.address() as { port: number }).port, origin = `https://127.0.0.1:${port}`;
  const env = { ...process.env, ARTHEGALL_DATA_DIR: root, ARTHEGALL_PORT: String(backendPort), ARTHEGALL_ORIGIN: origin, NODE_EXTRA_CA_CERTS: certificate };
  const cli = resolve('dist/scripts/arthegall.js');
  const setup = execFileSync(process.execPath, [cli, 'setup'], { env, encoding: 'utf8' });
  const code = setupCode(setup);
  const start = (command: string) => spawn(process.execPath, [cli, command, '--fake'], { env, stdio: 'ignore' });
  const stop = async (child: ChildProcess) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const closed = new Promise<void>((resolve) => child.once('close', resolve)); child.kill(); await closed;
  };
  const server = start('server'), runner = start('runner');
  const ca = readFileSync(certificate, 'utf8');
  const inherited = getCACertificates('default');
  let socket: WebSocket | undefined;
  try {
    setDefaultCACertificates([...inherited, ca]);
    await waitForServer(origin);
    const pairing = await pairNative(origin, code);
    const client = new NativeTestClient(origin, pairing.token);
    const snapshot = await client.snapshot();
    const admin = snapshot.conversations.find(conversation => conversation.administrator);
    assert(admin);
    socket = new WebSocket(origin.replace('https:', 'wss:') + '/client/v1/events?after=' + snapshot.cursor,
      { headers: client.headers, ca });
    const events: string[] = [];
    socket.on('message', raw => events.push(JSON.parse(raw.toString()).kind));
    await once(socket, 'open');
    const message = 'Synthetic HTTPS message';
    await client.send(admin.id, message);
    await waitFor('the runner outcome through the HTTPS proxy', () => events.includes('outcome'));
    const refreshed = await client.snapshot();
    assert.equal(refreshed.runnerConnected, true);
    assert.equal(refreshed.messages.filter(item => item.text === 'Synthetic response: ' + message).length, 1);
  } finally {
    socket?.terminate();
    setDefaultCACertificates(inherited);
    await stop(runner); await stop(server);
    proxy.closeAllConnections(); await new Promise<void>((resolve) => proxy.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
