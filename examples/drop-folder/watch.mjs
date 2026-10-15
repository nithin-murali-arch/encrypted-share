import { watch } from 'node:fs';
import { mkdir, readdir, rename, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sendFiles } from '@nithin93/encrypted-share';

export async function watchDropFolder({ folder, host, port, password, stableMs = 2000, retryMs = 5000, idleTimeoutMs = 60000, onEvent = console.log }) {
  folder = resolve(folder);
  const sending = join(folder, '.sending');
  const sent = join(folder, 'sent');
  await mkdir(sending, { recursive: true });
  await mkdir(sent, { recursive: true });
  const observed = new Map();
  const blocked = new Set();
  let closed = false;
  let active = Promise.resolve();
  let running = false;
  async function scan() {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const path = join(folder, entry.name);
      let current;
      try { current = await stat(path); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      const previous = observed.get(entry.name);
      if (!previous || previous.size !== current.size || previous.mtimeMs !== current.mtimeMs) {
        observed.set(entry.name, { size: current.size, mtimeMs: current.mtimeMs, stableSince: Date.now() });
        continue;
      }
      if (Date.now() - previous.stableSince < stableMs) continue;
      const occupied = await Promise.all([sending, sent].map(async dir => {
        try { await stat(join(dir, entry.name)); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
      }));
      if (occupied.some(Boolean)) {
        if (!blocked.has(entry.name)) onEvent(`blocked ${entry.name}: use a unique filename`);
        blocked.add(entry.name);
        continue;
      }
      await rename(path, join(sending, entry.name));
      observed.delete(entry.name);
    }
    for (const entry of await readdir(sending, { withFileTypes: true })) {
      if (closed || !entry.isFile() || blocked.has(entry.name)) continue;
      try {
        await sendFiles({ host, port, password, path: join(sending, entry.name), idleTimeoutMs });
        await rename(join(sending, entry.name), join(sent, entry.name));
        onEvent(`sent ${entry.name}`);
      } catch (error) {
        if (error.code === 'verify-failed' && error.message.includes('already exists')) {
          blocked.add(entry.name);
          onEvent(`blocked ${entry.name}: receiver already has this name; compare it before manual recovery`);
        } else {
          onEvent(`retry ${entry.name}: ${error.message}`);
          break;
        }
      }
    }
  }
  function wake() {
    if (closed || running) return;
    running = true;
    active = scan().catch(error => onEvent(`scan failed: ${error.message}`)).finally(() => { running = false; });
  }
  const watcher = watch(folder, wake);
  watcher.on('error', error => onEvent(`watch error: ${error.message}; periodic scan remains active`));
  const timer = setInterval(wake, retryMs);
  wake();
  return { async close() { closed = true; clearInterval(timer); watcher.close(); await active; } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { DROP_FOLDER, ES_HOST, ES_PORT = '3000', ES_PASSWORD } = process.env;
  if (!DROP_FOLDER || !ES_HOST || !ES_PASSWORD || !Number.isInteger(Number(ES_PORT)) || Number(ES_PORT) < 1 || Number(ES_PORT) > 65535) {
    throw new Error('set DROP_FOLDER, ES_HOST, ES_PASSWORD, and a valid ES_PORT');
  }
  const worker = await watchDropFolder({ folder: DROP_FOLDER, host: ES_HOST, port: Number(ES_PORT), password: ES_PASSWORD });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void worker.close());
}
