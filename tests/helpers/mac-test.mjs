import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

export function macTestEnvironment(script) {
  const args = process.argv.slice(2);
  if (args.length === 0) return;
  if (args.length !== 1 || args[0] !== '--ui') {
    console.error(`Usage: node ${script} [--ui]`);
    process.exit(1);
  }
  return xcodeEnvironment(`node ${script} --ui`);
}

export function xcodeEnvironment(command) {
  const version = env => spawnSync('xcodebuild', ['-version'], { env, encoding: 'utf8' });
  const selected = version(process.env);
  if (selected.status === 0) return process.env;
  const standard = '/Applications/Xcode.app/Contents/Developer';
  if (!process.env.DEVELOPER_DIR && existsSync(join(standard, 'usr/bin/xcodebuild'))) {
    const env = { ...process.env, DEVELOPER_DIR: standard };
    if (version(env).status === 0) {
      console.log('Using Xcode at /Applications/Xcode.app for this test.');
      return env;
    }
  }
  const detail = selected.stderr?.trim() || selected.error?.message;
  if (detail) console.error(detail);
  console.error('The Mac window test requires full Xcode. Install and open Xcode to finish setup, or select your installed copy with DEVELOPER_DIR.');
  console.error(`Example: DEVELOPER_DIR=${standard} ${command}`);
  process.exit(1);
}

export function runMacUI(suite, bundle, manifest, env) {
  return run('xcodebuild', ['-project', 'apps/mac/Arthegall.xcodeproj', '-scheme', 'Arthegall',
    '-destination', `platform=macOS,arch=${process.arch === 'arm64' ? 'arm64' : 'x86_64'}`,
    '-derivedDataPath', resolve('dist/mac-ui'), '-parallel-testing-enabled', 'NO',
    `-only-testing:ArthegallUITests/${suite}`, `ARTHEGALL_APP_ID=${bundle}`, 'test'],
  { ...env, TEST_RUNNER_ARTHEGALL_MAC_FIXTURE: manifest });
}

export function buildProbe(root, bundle, name) {
  const app = join(root, name + '.app');
  const executable = join(app, 'Contents', 'MacOS', name);
  mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true });
  writeFileSync(join(app, 'Contents', 'Info.plist'), `<plist version="1.0"><dict>
    <key>CFBundleExecutable</key><string>${name}</string>
    <key>CFBundleIdentifier</key><string>${bundle}</string>
    <key>CFBundlePackageType</key><string>APPL</string></dict></plist>`);
  execFileSync('xcrun', ['swiftc', '-parse-as-library', '-module-cache-path', resolve('dist/mac-probe-cache'),
    ...['Client', 'SettingsData', 'Storage', 'ConversationModel'].map(name => `apps/mac/Arthegall/${name}.swift`),
    `tests/fixtures/${name}.swift`, '-o', executable], { stdio: 'inherit' });
  execFileSync('codesign', ['--force', '--sign', '-', app]);
  return executable;
}

export async function run(executable, args, env = process.env) {
  const child = spawn(executable, args, { stdio: 'inherit', env });
  const status = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  assert.equal(status, 0, `${executable} completed`);
}
