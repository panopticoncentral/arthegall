import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, rmdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

if (process.platform !== 'darwin') throw new Error('Package the Mac app on macOS with Xcode installed');

const { values } = parseArgs({ options: {
  output: { type: 'string', default: 'release/arthegall-mac' },
  'build-number': { type: 'string', default: '1' },
  identity: { type: 'string', default: '-' },
  'bundle-id': { type: 'string', default: 'org.arthegall.mac' },
} });
const build = values['build-number'];
const bundle = values['bundle-id'];
if (!/^[1-9]\d*$/.test(build)) throw new Error('Use a positive integer for --build-number');
if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(bundle)) throw new Error('Use a reverse-DNS bundle identifier');

const destination = resolve(values.output);
if (existsSync(destination)) throw new Error('Package destination already exists. Choose a new --output directory');
mkdirSync(dirname(destination), { recursive: true });
const stage = mkdtempSync(join(dirname(destination), '.arthegall-mac-'));
const derived = join(stage, 'build');
const appName = 'Arthegall.app';

function plist(app: string, key: string) {
  return execFileSync('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', join(app, 'Contents', 'Info.plist')], { encoding: 'utf8' }).trim();
}

try {
  execFileSync('xcodebuild', ['-project', 'apps/mac/Arthegall.xcodeproj', '-scheme', 'Arthegall',
    '-configuration', 'Release', '-destination', 'generic/platform=macOS', '-derivedDataPath', derived,
    'ARCHS=arm64 x86_64', 'ONLY_ACTIVE_ARCH=NO', 'CODE_SIGNING_ALLOWED=NO',
    `ARTHEGALL_APP_ID=${bundle}`, `PRODUCT_BUNDLE_IDENTIFIER=${bundle}`, `CURRENT_PROJECT_VERSION=${build}`, '-quiet', 'build'],
  { stdio: 'inherit' });

  const app = join(derived, 'Build', 'Products', 'Release', appName);
  execFileSync('/usr/bin/codesign', ['--force', '--options', 'runtime', '--timestamp=none', '--sign', values.identity, app], { stdio: 'inherit' });
  const version = plist(app, 'CFBundleShortVersionString');
  if (!/^\d+(\.\d+){1,2}$/.test(version)) throw new Error('Unexpected app version in Info.plist');

  const zipName = `Arthegall-${version}-${build}-mac.zip`;
  const zip = join(stage, zipName);
  execFileSync('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, zip]);
  const extracted = join(stage, 'extracted');
  execFileSync('/usr/bin/ditto', ['-x', '-k', zip, extracted]);
  const installed = join(extracted, appName);
  execFileSync('/usr/bin/codesign', ['--verify', '--strict', '--deep', '--all-architectures', installed], { stdio: 'inherit' });
  const executable = join(installed, 'Contents', 'MacOS', plist(installed, 'CFBundleExecutable'));
  const minimum = plist(installed, 'LSMinimumSystemVersion');
  const architectures = execFileSync('xcrun', ['lipo', '-archs', executable], { encoding: 'utf8' }).trim().split(/\s+/).sort();
  if (architectures.join(' ') !== 'arm64 x86_64' || plist(installed, 'CFBundleIdentifier') !== bundle || plist(installed, 'CFBundleVersion') !== build)
    throw new Error('Packaged app identity, build number or architectures differ from the requested release');

  mkdirSync(destination);
  try {
    renameSync(zip, join(destination, zipName));
  } catch (error) {
    try { rmdirSync(destination); } catch { /* Preserve any files created by another process. */ }
    throw error;
  }
  console.log(`Packaged ${appName} for macOS ${minimum} or later: ${join(destination, zipName)}`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
