// Exercise actual signed app archives in a disposable installation against a synthetic server.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createServer } from '../dist/apps/server/src/server.js';
import { ServerStore } from '../dist/apps/server/src/store.js';
import { availablePort } from '../dist/tests/helpers/port.js';
import { reportingUpgrade } from '../dist/tests/helpers/reporting-upgrade.js';
import { runMacUI, xcodeEnvironment } from './helpers/mac-test.mjs';

const usage = 'node tests/mac-update.mjs INITIAL.zip UPDATE.zip';
const args = process.argv.slice(2);
if (args.length !== 2) throw new Error('Usage: ' + usage);
const ui = xcodeEnvironment(usage);
const root = mkdtempSync(join(tmpdir(), 'arthegall-mac-update-'));
let store, server;
try {
  const [initial, update] = args.map((file, index) => {
    const folder = join(root, index === 0 ? 'install' : 'update');
    execFileSync('/usr/bin/ditto', ['-x', '-k', resolve(file), folder]);
    return join(folder, 'Arthegall.app');
  });
  const bundle = plist(initial, 'CFBundleIdentifier');
  assert(bundle.startsWith('org.arthegall.fixture.'), 'Use a disposable --bundle-id for the install test');
  assert.equal(plist(update, 'CFBundleIdentifier'), bundle, 'Updates must retain the app identity');
  const initialBuild = Number(plist(initial, 'CFBundleVersion'));
  const updateBuild = Number(plist(update, 'CFBundleVersion'));
  assert(Number.isInteger(initialBuild) && Number.isInteger(updateBuild) && updateBuild > initialBuild, 'Increase --build-number for the update');
  const signature = spawnSync('/usr/bin/codesign', ['-d', '-r-', initial], { encoding: 'utf8' });
  assert.equal(signature.status, 0, 'Read initial app signing requirement');
  const requirement = (signature.stdout + signature.stderr).match(/^designated => (.+)$/m)?.[1];
  assert(requirement, 'The installed app must have a signing requirement');
  verify(initial, requirement);
  verify(update, requirement);

  const prior = await reportingUpgrade(root, 'Synthetic report saved before the app update.');
  store = new ServerStore(prior.serverPath);
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  server = await createServer(store, origin);
  const updatePath = `/fixture/${randomUUID()}/replace`;
  server.post(updatePath, async () => {
    const previous = join(root, 'previous.app');
    renameSync(initial, previous);
    try { renameSync(update, initial); } catch (error) { renameSync(previous, initial); throw error; }
    verify(initial, requirement);
    return { build: updateBuild };
  });
  await server.listen({ host: '127.0.0.1', port });
  const message = store.snapshot().runs.find(run => run.id === prior.run).messageId;
  const manifest = join(root, 'fixture.json');
  writeFileSync(manifest, JSON.stringify({ origin, bundle, dm: prior.dm, message, code: store.createPairingCode(),
    appURL: pathToFileURL(initial).href, updateURL: origin + updatePath, updateBuild }), { mode: 0o600 });
  await runMacUI('PackageUpdateTests', 'org.arthegall.fixture.runner.t' + randomUUID(), manifest, ui);
  assert.equal(plist(initial, 'CFBundleVersion'), String(updateBuild));
  assert.equal(store.db.prepare("SELECT count(*) FROM events WHERE kind='app_paired'").pluck().get(), 1);
  assert.equal(store.db.prepare('SELECT evidence FROM report_context WHERE run_id=?').pluck().get(prior.run), prior.evidence);
  console.log('Verified fresh pairing and an in-place app update with the same paired identity, saved report and draft.');
} finally {
  await server?.close();
  store?.close();
  rmSync(root, { recursive: true, force: true });
}

function plist(app, key) {
  return execFileSync('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', join(app, 'Contents', 'Info.plist')], { encoding: 'utf8' }).trim();
}

function verify(app, requirement) {
  execFileSync('/usr/bin/codesign', ['--verify', '--strict', '--all-architectures', '-R=' + requirement, app]);
}
