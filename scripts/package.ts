import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

const destination = resolve(process.argv[2] ?? `release/arthegall-${process.platform}-${process.arch}`);
const version = readFileSync('.nvmrc', 'utf8').trim().replace(/^v/, '');
if (process.versions.node !== version) throw new Error(`Package with the pinned Node ${version}`);
if (existsSync(destination)) throw new Error('Package destination already exists; choose a new empty destination');
if (!existsSync('dist/web/index.html')) throw new Error('Build the application before packaging');
mkdirSync(destination, { recursive: true });
for (const file of ['package.json', 'package-lock.json', 'README.md']) copyFileSync(file, join(destination, file));
cpSync('docs', join(destination, 'docs'), { recursive: true });
for (const workspace of ['apps/server', 'apps/runner', 'apps/web', 'packages/contracts']) {
  mkdirSync(join(destination, workspace), { recursive: true });
  copyFileSync(join(workspace, 'package.json'), join(destination, workspace, 'package.json'));
}
cpSync('dist', join(destination, 'dist'), { recursive: true, filter: (path) => !path.startsWith('dist/tests') });
// Resolve production dependencies from the same lockfile. Native install scripts
// run with the pinned build runtime on the target OS and architecture.
execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: destination, stdio: 'inherit', shell: process.platform === 'win32' });
mkdirSync(join(destination, 'runtime'));
if (!['darwin', 'linux'].includes(process.platform)) throw new Error('Release packaging supports macOS and Linux; Windows installer is a later milestone');
const binary = 'node';
const archiveName = `node-v${version}-${process.platform}-${process.arch}.tar.gz`;
const distribution = `https://nodejs.org/dist/v${version}`;
const download = async (url: string) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Runtime download failed (${response.status})`);
  return Buffer.from(await response.arrayBuffer());
};
const sums = (await download(`${distribution}/SHASUMS256.txt`)).toString('utf8');
const expected = sums.split('\n').find((line) => line.trim().endsWith(`  ${archiveName}`))?.split(/\s+/)[0];
const archive = await download(`${distribution}/${archiveName}`);
if (!expected || createHash('sha256').update(archive).digest('hex') !== expected) throw new Error('Official runtime checksum mismatch');
const staging = mkdtempSync(join(tmpdir(), 'arthegall-runtime-'));
try {
  const path = join(staging, archiveName);
  writeFileSync(path, archive);
  execFileSync('tar', ['-xzf', path, '-C', staging]);
  const runtime = join(staging, archiveName.replace(/\.tar\.gz$/, ''));
  copyFileSync(join(runtime, 'bin', 'node'), join(destination, 'runtime', binary));
  chmodSync(join(destination, 'runtime', binary), 0o755);
  copyFileSync(join(runtime, 'LICENSE'), join(destination, 'runtime', 'LICENSE'));
} finally { rmSync(staging, { recursive: true, force: true }); }
mkdirSync(join(destination, 'bin'));
writeFileSync(join(destination, 'bin', 'arthegall'), '#!/bin/sh\nset -eu\nbase=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)\nexec "$base/runtime/node" "$base/dist/scripts/arthegall.js" "$@"\n', { mode: 0o755 });
const build = createHash('sha256');
build.update(readFileSync('package-lock.json'));
function hashTree(path: string) {
  for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    build.update(entry.name);
    if (entry.isDirectory()) hashTree(join(path, entry.name)); else build.update(readFileSync(join(path, entry.name)));
  }
}
hashTree(join(destination, 'dist'));
writeFileSync(join(destination, 'release.json'), JSON.stringify({ buildId: build.digest('hex'), runtimeSha256: expected, version: JSON.parse(readFileSync('package.json', 'utf8')).version, node: version, platform: process.platform, arch: process.arch, lockSha256: createHash('sha256').update(readFileSync('package-lock.json')).digest('hex') }, null, 2));
// Verify the bundled native binding with the bundled runtime, not the build node.
execFileSync(join(destination, 'runtime', binary), ['--input-type=module', '-e', "import Database from 'better-sqlite3'; const db=new Database(':memory:'); db.prepare('SELECT 1').get(); db.close();"], { cwd: destination, stdio: 'inherit' });
console.log(`Packaged ${process.platform}/${process.arch}: ${destination}`);
