import { test, expect } from '@playwright/test';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer as createHttpsServer } from 'node:https';
import { request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { createHash, X509Certificate } from 'node:crypto';

test('trusted HTTPS reverse proxy preserves secure pairing and both WebSocket routes', async ({ playwright }) => {
  const root = mkdtempSync(join(tmpdir(), 'arthegall-https-'));
  const key = join(root, 'key.pem'), certificate = join(root, 'certificate.pem');
  // Trust exactly this ephemeral certificate in the browser, without disabling TLS validation.
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', certificate, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-addext', 'basicConstraints=critical,CA:TRUE'], { stdio: 'ignore' });
  const backendPort = 20000 + Math.floor(Math.random() * 10000);
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
  const code = setup.match(/minutes\): (\S+)/)![1]!;
  const start = (command: string) => spawn(process.execPath, [cli, command, '--fake'], { env, stdio: 'ignore' });
  const stop = async (child: ChildProcess) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const closed = new Promise<void>((resolve) => child.once('close', resolve)); child.kill(); await closed;
  };
  const server = start('server'), runner = start('runner');
  const publicKey = new X509Certificate(readFileSync(certificate)).publicKey.export({ type: 'spki', format: 'der' });
  const pin = createHash('sha256').update(publicKey).digest('base64');
  const browser = await playwright.chromium.launch({ args: [`--ignore-certificate-errors-spki-list=${pin}`] });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await expect.poll(async () => { try { await page.goto(origin); return await page.getByLabel('Pairing code').count(); } catch { return 0; } }).toBe(1);
    await page.getByLabel('Pairing code').fill(code);
    await page.getByRole('button', { name: 'Pair browser' }).click();
    const composer = page.getByLabel('Message Administrator', { exact: true });
    await composer.fill('Synthetic HTTPS message'); await composer.press('Enter');
    await expect(page.getByText('Synthetic response: Synthetic HTTPS message', { exact: true })).toBeVisible();
    const cookie = (await context.cookies()).find((cookie) => cookie.name === 'arthegall')!;
    expect(cookie.secure).toBe(true); expect(cookie.httpOnly).toBe(true); expect(cookie.sameSite).toBe('Strict');
    await page.reload();
    await expect(page.getByText('Synthetic response: Synthetic HTTPS message', { exact: true })).toHaveCount(1);
    await expect(page.getByRole('status')).toContainText('Connected');
    await context.close();
  } finally {
    await browser.close(); await stop(runner); await stop(server);
    proxy.closeAllConnections(); await new Promise<void>((resolve) => proxy.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
