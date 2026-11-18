import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
export function servicePlist(label: string, binary: string, cli: string, command: string, root: string, codex: string, path: string, extraCa?: string) {
  const string = (value: string) => `<string>${escape(value)}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>
<key>Label</key>${string(label)}
<key>ProgramArguments</key><array>${[binary, cli, command].map(string).join('')}</array>
<key>WorkingDirectory</key>${string(root)}
<key>EnvironmentVariables</key><dict><key>ARTHEGALL_DATA_DIR</key>${string(root)}<key>ARTHEGALL_CODEX_BIN</key>${string(codex)}<key>PATH</key>${string(path)}${extraCa ? `<key>NODE_EXTRA_CA_CERTS</key>${string(extraCa)}` : ''}</dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer><key>Umask</key><integer>63</integer>
<key>StandardOutPath</key>${string(join(root, 'logs', `${command}.log`))}
<key>StandardErrorPath</key>${string(join(root, 'logs', `${command}.error.log`))}
</dict></plist>\n`;
}
const Manifest = z.object({ version: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+$/), buildId: z.string().regex(/^[a-f0-9]{64}$/), platform: z.literal('darwin'), arch: z.string(), node: z.string(), lockSha256: z.string() });
export function manageService(action: string, root: string, source: string) {
  if (process.platform !== 'darwin') throw new Error('User-service installation currently supports macOS');
  const domain = `gui/${process.getuid!()}`;
  const suffix = createHash('sha256').update(root).digest('hex').slice(0, 12);
  const agents = resolve(process.env.ARTHEGALL_LAUNCH_AGENTS_DIR ?? join(homedir(), 'Library', 'LaunchAgents'));
  const entries = ['server', 'runner'].map((command) => ({ command, label: `com.arthegall.${suffix}.${command}`, file: join(agents, `com.arthegall.${suffix}.${command}.plist`) }));
  const loaded = (label: string) => spawnSync('/bin/launchctl', ['print', `${domain}/${label}`], { stdio: 'ignore' }).status === 0;
  const stop = () => {
    for (const entry of [...entries].reverse()) if (loaded(entry.label)) {
      const details = execFileSync('/bin/launchctl', ['print', `${domain}/${entry.label}`], { encoding: 'utf8' });
      const pid = Number(details.match(/\n\s*pid = (\d+)/)?.[1]);
      execFileSync('/bin/launchctl', ['bootout', `${domain}/${entry.label}`], { stdio: 'inherit' });
      // bootout can return while launchd is still removing the job. Rebootstrapping
      // at that point can skip a job that disappears immediately afterward.
      const processAlive = () => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } };
      const deadline = Date.now() + 15_000;
      while (loaded(entry.label) || processAlive()) {
        if (Date.now() > deadline) throw new Error(`${entry.command} has not stopped; inspect status before starting again`);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      }
    }
  };
  if (action === 'stop') { stop(); return; }
  if (action === 'status') {
    for (const entry of entries) {
      const result = spawnSync('/bin/launchctl', ['print', `${domain}/${entry.label}`], { encoding: 'utf8' });
      const state = result.stdout?.match(/\n\s*state = ([^\n]+)/)?.[1];
      const pid = result.stdout?.match(/\n\s*pid = (\d+)/)?.[1];
      const exit = result.stdout?.match(/\n\s*last exit code = ([^\n]+)/)?.[1];
      console.log(`${entry.command}: ${state ?? 'stopped'}${pid ? ` (pid ${pid})` : ''}${exit ? `; last exit ${exit}` : ''}`);
    }
    return;
  }
  if (action === 'install') {
    const nested = relative(source, root);
    if (!nested || (!nested.startsWith('..') && !isAbsolute(nested))) throw new Error('Private data must be outside the source package');
    const manifest = Manifest.parse(JSON.parse(readFileSync(join(source, 'release.json'), 'utf8')));
    if (manifest.arch !== process.arch || manifest.node !== process.versions.node) throw new Error('Package runtime or architecture mismatch');
    if (entries.some((entry) => loaded(entry.label))) throw new Error('Stop the existing services before installing');
    const destination = join(root, 'releases', `${manifest.version}-${manifest.buildId.slice(0, 12)}`);
    if (!existsSync(destination)) {
      mkdirSync(join(root, 'releases'), { recursive: true, mode: 0o700 });
      const staging = join(root, 'releases', `.install-${randomUUID()}`);
      try { cpSync(source, staging, { recursive: true }); renameSync(staging, destination); }
      finally { rmSync(staging, { recursive: true, force: true }); }
    }
    const binary = join(destination, 'runtime', 'node'), cli = join(destination, 'dist', 'scripts', 'arthegall.js');
    const codex = process.env.ARTHEGALL_CODEX_BIN ?? execFileSync('/usr/bin/which', ['codex'], { encoding: 'utf8' }).trim();
    if (!codex.startsWith('/') || !existsSync(codex)) throw new Error('Install Codex and set ARTHEGALL_CODEX_BIN to its absolute path');
    // Setup retains existing identities and browser pairing on repeated installs.
    execFileSync(binary, [cli, 'setup'], { env: { ...process.env, ARTHEGALL_DATA_DIR: root }, stdio: 'inherit' });
    mkdirSync(join(root, 'logs'), { recursive: true, mode: 0o700 });
    mkdirSync(agents, { recursive: true });
    const extraCa = process.env.NODE_EXTRA_CA_CERTS;
    if (extraCa && (!extraCa.startsWith('/') || !existsSync(extraCa))) throw new Error('NODE_EXTRA_CA_CERTS must name an existing absolute certificate path');
    for (const entry of entries) writeFileSync(entry.file, servicePlist(entry.label, binary, cli, entry.command, root, codex, process.env.PATH ?? '/usr/bin:/bin', extraCa), { mode: 0o600 });
    console.log(`Installed launcher: ${join(destination, 'bin', 'arthegall')}`);
  }
  if (!['start', 'restart', 'install'].includes(action)) throw new Error('Unknown service action');
  if (action === 'restart') stop();
  for (const entry of entries) {
    if (!existsSync(entry.file)) throw new Error('Run install from a packaged release first');
    if (!loaded(entry.label)) execFileSync('/bin/launchctl', ['bootstrap', domain, entry.file], { stdio: 'inherit' });
  }
  console.log('User services started. Use status to inspect them.');
}
