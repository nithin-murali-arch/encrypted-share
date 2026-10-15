import { createHash } from 'crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { connect, createServer, Server, Socket } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { sendFiles, startServer, ServerHandle, ServerOptions, TransferError } from '../src/index';
import { HELLO_LENGTH } from '../src/protocol';

jest.setTimeout(15000);

const PASSWORD = 'tamper-test-password';
const AUTH_FAILURE =
  'transfer failed: frame authentication failed: wrong password, or the frame was altered, dropped, reordered or replayed';

type FrameHook = (index: number, frame: Buffer) => Buffer[];

interface Direction {
  captured: Buffer[];
  frames: Buffer[];
}

interface Proxy {
  port: number;
  c2s: Direction;
  s2c: Direction;
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  cleanups.push(() => closeServer(server));
  return (server.address() as { port: number }).port;
}

async function withServer(
  outDir: string,
  extra: Partial<ServerOptions> = {},
): Promise<{ port: number; log: string[] }> {
  const log: string[] = [];
  const handle: ServerHandle = await startServer({
    port: 0,
    password: PASSWORD,
    outDir,
    onTransfer: (m) => log.push(m),
    ...extra,
  });
  cleanups.push(() => handle.close());
  return { port: handle.port, log };
}

function relay(from: Socket, to: Socket, dir: Direction, hook: FrameHook): void {
  let pending = Buffer.alloc(0);
  let helloSent = false;
  from.on('data', (chunk: Buffer) => {
    dir.captured.push(chunk);
    pending = Buffer.concat([pending, chunk]);
    if (!helloSent) {
      if (pending.length < HELLO_LENGTH) return;
      to.write(pending.subarray(0, HELLO_LENGTH));
      pending = pending.subarray(HELLO_LENGTH);
      helloSent = true;
    }
    while (pending.length >= 4 && pending.length >= 4 + pending.readUInt32BE(0)) {
      const frame = pending.subarray(0, 4 + pending.readUInt32BE(0));
      pending = pending.subarray(frame.length);
      for (const out of hook(dir.frames.length, frame)) to.write(out);
      dir.frames.push(frame);
    }
  });
  from.on('end', () => {
    if (pending.length > 0) to.write(pending);
    to.end();
  });
  from.on('close', () => to.destroy());
  from.on('error', () => to.destroy());
}

async function startProxy(
  targetPort: number,
  hooks: { c2s?: FrameHook; s2c?: FrameHook } = {},
): Promise<Proxy> {
  const pass: FrameHook = (_i, frame) => [frame];
  const c2s: Direction = { captured: [], frames: [] };
  const s2c: Direction = { captured: [], frames: [] };
  const server = createServer((client) => {
    const upstream = connect(targetPort, '127.0.0.1');
    relay(client, upstream, c2s, hooks.c2s ?? pass);
    relay(upstream, client, s2c, hooks.s2c ?? pass);
  });
  const port = await listen(server);
  return { port, c2s, s2c };
}

interface HeldConnection {
  client: Socket;
  upstream: Socket;
  held: Buffer[];
}

interface HoldingProxy {
  port: number;
  holdAfterFrames: number | null;
  connections: HeldConnection[];
}

// Holds every client frame past holdAfterFrames and keeps the upstream connection
// open after the client gives up, so the frames can be delivered later.
async function startHoldingProxy(targetPort: number): Promise<HoldingProxy> {
  const proxy: HoldingProxy = { port: 0, holdAfterFrames: null, connections: [] };
  const server = createServer((client) => {
    const upstream = connect(targetPort, '127.0.0.1');
    const conn: HeldConnection = { client, upstream, held: [] };
    proxy.connections.push(conn);
    const holdAfter = proxy.holdAfterFrames;
    let pending = Buffer.alloc(0);
    let helloSent = false;
    let seen = 0;
    client.on('data', (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      if (!helloSent) {
        if (pending.length < HELLO_LENGTH) return;
        upstream.write(pending.subarray(0, HELLO_LENGTH));
        pending = pending.subarray(HELLO_LENGTH);
        helloSent = true;
      }
      while (pending.length >= 4 && pending.length >= 4 + pending.readUInt32BE(0)) {
        const frame = pending.subarray(0, 4 + pending.readUInt32BE(0));
        pending = pending.subarray(frame.length);
        if (holdAfter !== null && seen >= holdAfter) conn.held.push(frame);
        else upstream.write(frame);
        seen += 1;
      }
    });
    upstream.on('data', (chunk: Buffer) => {
      if (!client.destroyed) client.write(chunk);
    });
    client.on('error', () => {});
    upstream.on('error', () => {});
    upstream.on('close', () => client.destroy());
    client.on('close', () => {
      if (holdAfter === null) upstream.end();
    });
  });
  proxy.port = await listen(server);
  cleanups.push(() => {
    for (const c of proxy.connections) {
      c.client.destroy();
      c.upstream.destroy();
    }
  });
  return proxy;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until(condition: () => boolean): Promise<void> {
  for (let waited = 0; !condition(); waited += 10) {
    if (waited > 5000) throw new Error('condition not met within 5 s');
    await sleep(10);
  }
}

function flipByteIn(target: number): FrameHook {
  return (index, frame) => {
    if (index !== target) return [frame];
    const out = Buffer.from(frame);
    out[out.length - 20] ^= 0x01;
    return [out];
  };
}

function sha(data: string): string {
  return createHash('sha256').update(data).digest('hex');
}

function sourceFile(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'es-tamper-src-'));
  writeFileSync(join(dir, name), content);
  return join(dir, name);
}

function emptyDir(): string {
  return mkdtempSync(join(tmpdir(), 'es-tamper-out-'));
}

async function rejection(pending: Promise<unknown>): Promise<TransferError> {
  try {
    await pending;
  } catch (err) {
    expect(err).toBeInstanceOf(TransferError);
    return err as TransferError;
  }
  throw new Error('expected sendFiles to reject');
}

function legacyHeader(): Buffer {
  const json = Buffer.from(
    JSON.stringify({
      salt: Buffer.alloc(16, 1).toString('base64'),
      baseNonce: Buffer.alloc(4, 2).toString('base64'),
      chunkSize: 65536,
      files: [{ path: 'old.txt', size: 3, sha256: sha('old') }],
      dirs: [],
    }),
  );
  const prefix = Buffer.alloc(10);
  prefix.write('ES02', 0, 'ascii');
  prefix.writeUInt16BE(2, 4);
  prefix.writeUInt32BE(json.length, 6);
  return Buffer.concat([prefix, json]);
}

async function exchangeRaw(port: number, payload: Buffer): Promise<Buffer> {
  const socket = connect(port, '127.0.0.1');
  const received: Buffer[] = [];
  socket.on('data', (chunk: Buffer) => received.push(chunk));
  socket.on('error', () => {});
  socket.write(payload);
  await new Promise<void>((resolve) => socket.once('close', () => resolve()));
  return Buffer.concat(received);
}

describe('ES03 against a man in the middle', () => {
  test('1. file names and hashes never appear on the wire', async () => {
    const name = 'secret-plan-7f3a.txt';
    const content = 'launch at dawn';
    const out = emptyDir();
    const { port } = await withServer(out);
    const proxy = await startProxy(port);
    const report = await sendFiles({
      host: '127.0.0.1',
      port: proxy.port,
      password: PASSWORD,
      path: sourceFile(name, content),
    });
    expect(report).toEqual({ files: [name], bytes: 14 });
    expect(readFileSync(join(out, name), 'utf8')).toBe(content);
    const c2s = Buffer.concat(proxy.c2s.captured);
    const s2c = Buffer.concat(proxy.s2c.captured);
    expect(c2s.includes(name)).toBe(false);
    expect(c2s.includes(sha(content))).toBe(false);
    expect(c2s.includes(content)).toBe(false);
    expect(s2c.includes(name)).toBe(false);
    expect(proxy.c2s.frames.length).toBe(3);
  });

  test('2. a tampered HEADER fails the transfer and lands nothing', async () => {
    const out = emptyDir();
    const { port, log } = await withServer(out);
    const proxy = await startProxy(port, { c2s: flipByteIn(0) });
    const err = await rejection(
      sendFiles({ host: '127.0.0.1', port: proxy.port, password: PASSWORD, path: sourceFile('a.txt', 'AAA') }),
    );
    expect(err.code).toBe('rejected');
    expect(readdirSync(out)).toEqual([]);
    expect(log).toEqual([AUTH_FAILURE]);
  });

  test('3. a tampered RESUME fails with decrypt-failed before any CHUNK', async () => {
    const out = emptyDir();
    const { port } = await withServer(out);
    const proxy = await startProxy(port, { s2c: flipByteIn(0) });
    const err = await rejection(
      sendFiles({ host: '127.0.0.1', port: proxy.port, password: PASSWORD, path: sourceFile('a.txt', 'AAA') }),
    );
    expect(err.code).toBe('decrypt-failed');
    expect(proxy.c2s.frames.length).toBe(1);
  });

  test('4. a tampered RESULT fails with decrypt-failed, not success', async () => {
    const out = emptyDir();
    const { port } = await withServer(out);
    const proxy = await startProxy(port, { s2c: flipByteIn(1) });
    const err = await rejection(
      sendFiles({ host: '127.0.0.1', port: proxy.port, password: PASSWORD, path: sourceFile('a.txt', 'AAA') }),
    );
    expect(err.code).toBe('decrypt-failed');
    expect(proxy.s2c.frames.length).toBe(2);
  });

  test('5. a forged ES02-style cleartext RESULT is rejected', async () => {
    const out = emptyDir();
    const { port } = await withServer(out);
    const json = Buffer.from(JSON.stringify({ ok: true, verified: ['a.txt'], failed: [] }));
    const forged = Buffer.concat([Buffer.alloc(4), json]);
    forged.writeUInt32BE(json.length, 0);
    const proxy = await startProxy(port, {
      s2c: (index, frame) => [index === 1 ? forged : frame],
    });
    const err = await rejection(
      sendFiles({ host: '127.0.0.1', port: proxy.port, password: PASSWORD, path: sourceFile('a.txt', 'AAA') }),
    );
    expect(err.code).toBe('decrypt-failed');
  });

  test.each([
    ['dropped', (index: number, frame: Buffer): Buffer[] => (index === 2 ? [] : [frame])],
    [
      'reordered',
      ((): FrameHook => {
        let held: Buffer | null = null;
        return (index, frame) => {
          if (index === 2) {
            held = frame;
            return [];
          }
          return index === 3 ? [frame, held!] : [frame];
        };
      })(),
    ],
  ])('6. a %s CHUNK fails the transfer and lands nothing', async (_label, hook) => {
    const out = emptyDir();
    const { port, log } = await withServer(out);
    const proxy = await startProxy(port, { c2s: hook });
    const err = await rejection(
      sendFiles({
        host: '127.0.0.1',
        port: proxy.port,
        password: PASSWORD,
        path: sourceFile('big.txt', '0123456789abcdefghijklmn'),
        chunkSize: 4,
      }),
    );
    expect(['truncated', 'transfer-failed']).toContain(err.code);
    expect(readdirSync(out)).toEqual(['.es-partial']);
    expect(log).toEqual(['incoming transfer: 1 file(s), 0 dir(s)', AUTH_FAILURE]);
  });

  test('7. a recorded session replayed to the server is rejected', async () => {
    const out = emptyDir();
    const { port, log } = await withServer(out);
    const proxy = await startProxy(port);
    await sendFiles({ host: '127.0.0.1', port: proxy.port, password: PASSWORD, path: sourceFile('a.txt', 'AAA') });
    expect(readdirSync(out)).toEqual(['a.txt']);
    rmSync(join(out, 'a.txt'));

    const reply = await exchangeRaw(port, Buffer.concat(proxy.c2s.captured));
    expect(reply.length).toBe(HELLO_LENGTH);
    expect(readdirSync(out)).toEqual([]);
    expect(log).toEqual([
      'incoming transfer: 1 file(s), 0 dir(s)',
      'transfer complete: 1 file(s) verified',
      AUTH_FAILURE,
    ]);
  });

  test('8. an ES02 sender gets an ES02 RESUME telling it to upgrade', async () => {
    const out = emptyDir();
    const { port, log } = await withServer(out);
    const reply = await exchangeRaw(port, legacyHeader());
    expect(reply.readUInt32BE(0)).toBe(reply.length - 4);
    expect(JSON.parse(reply.subarray(4).toString('utf8'))).toEqual({
      received: {},
      error: 'this server runs encrypted-share 3 (wire protocol ES03); upgrade the sender to encrypted-share 3.x',
    });
    expect(readdirSync(out)).toEqual([]);
    expect(log).toEqual(['rejected an encrypted-share 2.x sender (wire protocol ES02); it must upgrade to 3.x']);
  });

  test('8b. unknown magic closes the connection with a logged reason', async () => {
    const out = emptyDir();
    const { port, log } = await withServer(out);
    const reply = await exchangeRaw(port, Buffer.from('GET / HTTP/1.1\r\n\r\n'));
    expect(reply.length).toBe(0);
    expect(log).toEqual(['transfer failed: unknown protocol magic "GET "']);
  });

  test('9. an ES02 server that hangs up fails with handshake-failed', async () => {
    const oldServer = createServer((socket) => {
      let got = 0;
      socket.on('data', (chunk: Buffer) => {
        got += chunk.length;
        if (got >= 10) socket.destroy();
      });
    });
    const port = await listen(oldServer);
    const err = await rejection(
      sendFiles({ host: '127.0.0.1', port, password: PASSWORD, path: sourceFile('a.txt', 'AAA') }),
    );
    expect(err.code).toBe('handshake-failed');
    expect(err.message).toBe(
      'server closed the connection during the handshake; it may run encrypted-share 2.x or an incompatible version',
    );
  });

  test('10. frames held back and released after a newer transfer cannot revert the file', async () => {
    const out = emptyDir();
    const { port, log } = await withServer(out, { overwrite: true });
    const proxy = await startHoldingProxy(port);

    proxy.holdAfterFrames = 1;
    const first = rejection(
      sendFiles({ host: '127.0.0.1', port: proxy.port, password: PASSWORD, path: sourceFile('config.txt', 'v1 old config') }),
    );
    await until(() => proxy.connections[0]?.held.length === 2);
    const held = proxy.connections[0];
    held.client.destroy();
    expect((await first).code).toBe('truncated');

    proxy.holdAfterFrames = null;
    await sendFiles({ host: '127.0.0.1', port: proxy.port, password: PASSWORD, path: sourceFile('config.txt', 'v2 new config') });
    expect(readFileSync(join(out, 'config.txt'), 'utf8')).toBe('v2 new config');

    proxy.holdAfterFrames = 1;
    const later = rejection(
      sendFiles({ host: '127.0.0.1', port: proxy.port, password: PASSWORD, path: sourceFile('other.txt', 'later') }),
    );
    await until(() => proxy.connections[2]?.held.length === 2);
    expect(readdirSync(out).sort()).toEqual(['.es-partial', 'config.txt']);

    for (const frame of held.held) held.upstream.write(frame);
    await sleep(300);
    expect(readFileSync(join(out, 'config.txt'), 'utf8')).toBe('v2 new config');
    proxy.connections[2].client.destroy();
    expect((await later).code).toBe('truncated');
    expect(log).toContain('superseded an unfinished transfer');
    expect(log.filter((m) => m.startsWith('transfer complete'))).toEqual(['transfer complete: 1 file(s) verified']);
  });
});
