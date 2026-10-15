import assert from 'node:assert/strict';
import { randomFillSync, randomBytes } from 'node:crypto';
import { fork, execFileSync } from 'node:child_process';
import { mkdtemp, open, readFile, rm, statfs } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { startServer } from '@nithin93/encrypted-share';

const total = Number(process.env.FILE_BYTES ?? 2 * 1024 ** 3);
assert(Number.isSafeInteger(total) && total >= 1024 * 1024, 'FILE_BYTES must be an integer of at least 1 MiB');
const space = await statfs(tmpdir());
assert(space.bavail * space.bsize > total * 2 + 512 * 1024 ** 2, 'need space for source, received file, and 512 MiB reserve');
const work = await mkdtemp(join(tmpdir(), 'encrypted-share-resume-'));
const source = join(work, 'dataset.bin');
const outDir = join(work, 'received');
const password = randomBytes(32).toString('hex');
let server;
function sender(stopAfter, offset) {
  return new Promise((resolve, reject) => {
    const child = fork(fileURLToPath(new URL('./sender.mjs', import.meta.url)),
      [source, String(server.port), password, String(stopAfter), String(offset)], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    let report;
    child.on('message', value => { report = value; });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal, report }));
  });
}
try {
  const file = await open(source, 'w');
  try {
    const chunk = Buffer.alloc(1024 * 1024);
    for (let written = 0; written < total;) {
      randomFillSync(chunk);
      const length = Math.min(chunk.length, total - written);
      let offset = 0;
      while (offset < length) {
        const { bytesWritten } = await file.write(chunk, offset, length - offset);
        assert(bytesWritten > 0, 'random-file write made progress');
        offset += bytesWritten;
      }
      written += length;
    }
    assert.equal((await file.stat()).size, total);
  } finally { await file.close(); }
  console.log(`created ${total} random bytes`);
  server = await startServer({ port: 0, password, outDir, onTransfer: console.log });
  const interrupted = await sender(Math.floor(total / 2), 0);
  assert.equal(interrupted.signal, 'SIGKILL');
  await delay(500);
  const state = JSON.parse(await readFile(join(outDir, '.es-partial', 'state.json'), 'utf8'));
  const offset = state.files[0].received;
  assert(offset > 0 && offset < total, 'receiver saved a nonzero partial offset');
  console.log(`persisted resume offset=${offset}`);
  const resumed = await sender(0, offset);
  assert.equal(resumed.code, 0);
  assert.equal(resumed.report.bytes, total - offset);
  execFileSync('cmp', [source, join(outDir, 'dataset.bin')]);
  console.log(`PASS cmp identical; resumed sent=${resumed.report.bytes}; skipped=${offset}`);
} finally {
  await server?.close();
  if (process.env.KEEP_FILES === '1') console.log(`kept ${work}`);
  else await rm(work, { recursive: true, force: true });
}
