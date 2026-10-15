import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const tarball = process.argv[2];
assert(tarball, 'pass the npm pack tarball path');
const work = await mkdtemp(join(tmpdir(), 'encrypted-share-offline-'));
try {
  execFileSync('npm', ['install', '--offline', '--global', '--prefix', join(work, 'prefix'),
    '--cache', join(work, 'empty-cache'), '--registry', 'http://127.0.0.1:9', resolve(tarball)],
  { stdio: 'inherit' });
  const version = execFileSync(join(work, 'prefix', 'bin', 'encrypted-share'), ['--version'], { encoding: 'utf8' }).trim();
  assert.match(version, /^3\./);
  console.log(`PASS offline CLI ${version}, fresh prefix, empty cache`);
} finally {
  await rm(work, { recursive: true, force: true });
}
