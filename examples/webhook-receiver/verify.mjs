import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { sendFiles } from '@nithin93/encrypted-share';
import { createWebhookNotifier, startReceiver } from './receiver.mjs';

const installed = import.meta.resolve('@nithin93/encrypted-share');
assert.match(installed, /\/webhook-receiver\/node_modules\/@nithin93\/encrypted-share\/dist\/index\.js$/,
  'Install the packed package inside this example before verification');
const directory = await mkdtemp(join(tmpdir(), 'encrypted-share-webhook-'));
const bodies = [];
const errors = [];
let completedResponses = 0;
const collector = createServer(async (request, response) => {
  if (request.url === '/timeout') return;
  if (request.url === '/failure') {
    request.resume();
    response.writeHead(503).end();
    return;
  }
  try {
    let body = '';
    for await (const chunk of request) body += chunk;
    bodies.push({ method: request.method, contentType: request.headers['content-type'], body: JSON.parse(body) });
    await delay(75);
    response.writeHead(204).end();
    completedResponses += 1;
  } catch (error) {
    errors.push(error.message);
    response.writeHead(400).end();
  }
});
await new Promise((resolve, reject) => {
  collector.once('error', reject);
  collector.listen(0, '127.0.0.1', resolve);
});
const webhookUrl = `http://127.0.0.1:${collector.address().port}/transfers`;
let receiver;
try {
  const notifier = createWebhookNotifier({ webhookUrl });
  for (const message of [
    'incoming transfer: 1 file(s), 0 dir(s)',
    'transfer failed: wrong password',
    'transfer failed verification: hello.txt',
    'superseded an unfinished transfer',
    'transfer complete: 1 file(s) verified extra',
    'server error: test',
  ]) {
    assert.equal(notifier.onTransfer(message), undefined, 'Callback must return synchronously');
  }
  await notifier.flush();
  assert.deepEqual(bodies, [], 'Unrelated callback messages must not post');

  const payload = Buffer.from('A real encrypted transfer triggers one completion webhook.\n');
  const path = join(directory, 'hello.txt');
  const outDir = join(directory, 'received');
  await writeFile(path, payload);
  receiver = await startReceiver({ password: 'local-verification-password', outDir, port: 0, webhookUrl });
  const report = await sendFiles({ host: '127.0.0.1', port: receiver.port, password: 'local-verification-password', path });
  assert.deepEqual(report.files, ['hello.txt']);
  assert.equal(report.bytes, payload.length);
  await receiver.close();
  receiver = undefined;
  assert.equal(completedResponses, 1, 'Shutdown must wait for the pending webhook response');
  assert.deepEqual(await readFile(join(outDir, 'hello.txt')), payload);
  assert.deepEqual(bodies, [{
    method: 'POST',
    contentType: 'application/json',
    body: { event: 'transfer.complete', verifiedFiles: 1, message: 'transfer complete: 1 file(s) verified' },
  }], 'One transfer must produce exactly one valid completion request in this run');
  assert.deepEqual(errors, []);

  for (const route of ['failure', 'timeout']) {
    const failures = [];
    const failing = createWebhookNotifier({
      webhookUrl: new URL(`/${route}`, webhookUrl),
      timeoutMs: 100,
      logError: (message) => failures.push(message),
    });
    assert.equal(failing.onTransfer('transfer complete: 1 file(s) verified'), undefined);
    await failing.flush();
    assert.equal(failures.length, 1, `${route} must report one caught delivery failure`);
    assert.match(failures[0], route === 'failure' ? /HTTP 503/ : /timeout|aborted/i);
  }
  console.log(`PASS packed package ${installed}`);
  console.log('PASS real encrypted TCP transfer, byte equality, one completion JSON request, and shutdown drain');
  console.log('PASS six unrelated callback messages produce no request');
  console.log('PASS HTTP 503 and 100 ms timeout are caught and drained');
} finally {
  await receiver?.close();
  collector.closeAllConnections();
  await new Promise((resolve, reject) => collector.close((error) => error ? reject(error) : resolve()));
  await rm(directory, { recursive: true, force: true });
}
