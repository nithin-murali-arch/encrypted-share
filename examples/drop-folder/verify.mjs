import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { fork } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { watchDropFolder } from './watch.mjs';
const work = await mkdtemp(join(tmpdir(), 'encrypted-share-drop-'));
const folder = join(work, 'drop');
const outDir = join(work, 'received');
await mkdir(folder);
const password = randomBytes(32).toString('hex');
let receiver;
let worker;
async function until(check, message) {
  for (let i = 0; i < 600; i++) { if (await check()) return; await delay(50); }
  throw new Error(message);
}
function start(port = 0) {
  return new Promise((resolve, reject) => {
    receiver = fork(fileURLToPath(new URL('./receiver.mjs', import.meta.url)), [outDir, password, String(port)], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    receiver.once('error', reject);
    receiver.on('message', value => { if (value.port) resolve(value.port); });
  });
}
async function stop() {
  if (!receiver || receiver.exitCode !== null || receiver.signalCode !== null) return;
  const exited = new Promise(resolve => receiver.once('exit', resolve));
  receiver.kill('SIGKILL');
  await exited;
}
try {
  const port = await start();
  const events = [];
  worker = await watchDropFolder({ folder, host: '127.0.0.1', port, password, stableMs: 100, retryMs: 100, onEvent: event => { events.push(event); console.log(event); } });
  const files = new Map([['one.bin', randomBytes(32 * 1024 * 1024)], ['two.txt', Buffer.from('two')], ['three.txt', Buffer.from('three')]]);
  for (const [name, bytes] of files) await writeFile(join(folder, name), bytes);
  await until(async () => {
    try { const state = JSON.parse(await readFile(join(outDir, '.es-partial', 'state.json'), 'utf8')); return state.files.some(file => file.received > 0 && file.received < file.size); } catch { return false; }
  }, 'receiver never persisted a partial file');
  await stop();
  await until(() => events.some(event => event.startsWith('retry ')), 'watcher did not observe receiver interruption');
  await start(port);
  await until(async () => (await readdir(join(folder, 'sent'))).length === 3, 'files were not archived after receiver restart');
  assert.deepEqual((await readdir(outDir)).sort(), [...files.keys()].sort());
  for (const [name, bytes] of files) assert.deepEqual(await readFile(join(outDir, name)), bytes);
  assert.equal(events.filter(event => event.startsWith('sent ')).length, 3);
  console.log('PASS three byte-identical destination files and three local archives after receiver restart');
} finally {
  await worker?.close();
  await stop();
  await rm(work, { recursive: true, force: true });
}
