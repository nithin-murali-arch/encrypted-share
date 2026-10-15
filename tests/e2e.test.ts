import { createHash } from 'crypto';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, existsSync, writeFileSync } from 'fs';
import { connect } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { SocketChannel } from '../src/channel';
import { clientHandshake } from '../src/client';
import { sendFiles } from '../src/index';
import { FrameType, TransferError } from '../src/protocol';
import { SecureChannel } from '../src/secure-channel';
import { startServer, ServerHandle } from '../src/index';
import { PartialStore } from '../src/store';

jest.setTimeout(15000);

function sha(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

const servers: ServerHandle[] = [];
afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()!.close();
  }
});

async function withServer(
  outDir: string,
  opts: { password?: string; overwrite?: boolean } = {},
): Promise<{ port: number; log: string[] }> {
  const log: string[] = [];
  const handle = await startServer({
    port: 0,
    password: opts.password ?? 'test-password',
    outDir,
    overwrite: opts.overwrite,
    onTransfer: (m) => log.push(m),
  });
  servers.push(handle);
  return { port: handle.port, log };
}

async function openSession(port: number, password = 'test-password'): Promise<{ ch: SocketChannel; sc: SecureChannel }> {
  const socket = connect(port, '127.0.0.1');
  await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
  const ch = new SocketChannel(socket);
  return { ch, sc: await clientHandshake(ch, password) };
}

function makeTree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'es-e2e-src-'));
  writeFileSync(join(dir, 'a.txt'), 'AAA');
  mkdirSync(join(dir, 'sub', 'empty'), { recursive: true });
  writeFileSync(join(dir, 'sub', 'b.txt'), 'BBBB');
  writeFileSync(join(dir, 'empty.txt'), '');
  return dir;
}

describe('e2e', () => {
  test('directory transfer lands byte-identical', async () => {
    const src = makeTree();
    const out = mkdtempSync(join(tmpdir(), 'es-e2e-out-'));
    const { port, log } = await withServer(out);
    const progress: Array<[number, number]> = [];
    const report = await sendFiles({
      host: '127.0.0.1',
      port,
      password: 'test-password',
      path: src,
      chunkSize: 2,
      onProgress: (sent, total) => progress.push([sent, total]),
    });
    expect(report.files.sort()).toEqual(['a.txt', 'empty.txt', 'sub/b.txt']);
    expect(report.bytes).toBe(7);
    expect(readFileSync(join(out, 'a.txt'), 'utf8')).toBe('AAA');
    expect(readFileSync(join(out, 'sub/b.txt'), 'utf8')).toBe('BBBB');
    expect(readFileSync(join(out, 'empty.txt'), 'utf8')).toBe('');
    expect(existsSync(join(out, 'sub/empty'))).toBe(true);
    expect(existsSync(join(out, '.es-partial'))).toBe(false);
    expect(log.join('\n')).toMatch(/transfer complete/);
    expect(progress[0]).toEqual([0, 7]);
    expect(progress[progress.length - 1]).toEqual([7, 7]);
    for (let i = 1; i < progress.length; i++) {
      expect(progress[i][0]).toBeGreaterThanOrEqual(progress[i - 1][0]);
    }
  });

  test('single file transfer works', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'es-e2e-src-'));
    writeFileSync(join(dir, 'one.txt'), 'ONE');
    const out = mkdtempSync(join(tmpdir(), 'es-e2e-out-'));
    const { port } = await withServer(out);
    const report = await sendFiles({
      host: '127.0.0.1',
      port,
      password: 'test-password',
      path: join(dir, 'one.txt'),
    });
    expect(report).toEqual({ files: ['one.txt'], bytes: 3 });
    expect(readFileSync(join(out, 'one.txt'), 'utf8')).toBe('ONE');
  });

  test('resume completes from seeded partial state', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'es-e2e-src-'));
    const content = '0123456789abcdefghijklmn';
    writeFileSync(join(dir, 'big.txt'), content);
    const out = mkdtempSync(join(tmpdir(), 'es-e2e-out-'));
    const seed = new PartialStore({ outDir: out });
    await seed.prepare([{ path: 'big.txt', size: 24, sha256: sha(content) }], []);
    for (let i = 0; i < 8; i++) {
      await seed.append(0, BigInt(i * 2), Buffer.from(content.slice(i * 2, i * 2 + 2)));
    }
    const { port } = await withServer(out);
    const report = await sendFiles({
      host: '127.0.0.1',
      port,
      password: 'test-password',
      path: join(dir, 'big.txt'),
      chunkSize: 4,
    });
    expect(report.bytes).toBe(8);
    expect(readFileSync(join(out, 'big.txt'), 'utf8')).toBe(content);
  });

  test('wrong password fails and lands nothing', async () => {
    const src = makeTree();
    const out = mkdtempSync(join(tmpdir(), 'es-e2e-out-'));
    const { port, log } = await withServer(out, { password: 'correct' });
    await expect(
      sendFiles({ host: '127.0.0.1', port, password: 'wrong', path: src }),
    ).rejects.toThrow(
      expect.objectContaining({
        code: 'rejected',
        message:
          'server closed the connection after the header; check that both sides use the same password',
      }),
    );
    expect(readdirSync(out)).toEqual([]);
    expect(log).toEqual([
      'transfer failed: frame authentication failed: wrong password, or the frame was altered, dropped, reordered or replayed',
    ]);
  });

  test('tampered chunk destroys the transfer without landing', async () => {
    const out = mkdtempSync(join(tmpdir(), 'es-e2e-out-'));
    const { port, log } = await withServer(out);
    const { ch, sc } = await openSession(port);
    try {
      await sc.send(FrameType.HEADER, {
        chunkSize: 64,
        files: [{ path: 'evil.txt', size: 5, sha256: sha('HELLO') }],
        dirs: [],
      });
      expect((await sc.recv([FrameType.RESUME])).body).toEqual({ received: { 'evil.txt': 0 } });
      const forged = Buffer.alloc(4 + 34, 0x5a);
      forged.writeUInt32BE(34, 0);
      await ch.write(forged);
      await expect(ch.readFrame()).rejects.toThrow(TransferError);
    } finally {
      ch.destroy();
    }
    expect(readdirSync(out)).toEqual(['.es-partial']);
    expect(log[log.length - 1]).toMatch(/^transfer failed: frame authentication failed/);
  });

  test('checksum mismatch yields a failed RESULT, not a crash', async () => {
    const out = mkdtempSync(join(tmpdir(), 'es-e2e-out-'));
    const { port, log } = await withServer(out);
    const { ch, sc } = await openSession(port);
    try {
      await sc.send(FrameType.HEADER, {
        chunkSize: 64,
        files: [{ path: 'bad.txt', size: 5, sha256: sha('RIGHT') }],
        dirs: [],
      });
      await sc.recv([FrameType.RESUME]);
      await sc.send(FrameType.CHUNK, { fileIndex: 0, offset: 0n, data: Buffer.from('WRONG') });
      await sc.send(FrameType.DONE, null);
      expect((await sc.recv([FrameType.RESULT])).body).toEqual({
        ok: false,
        verified: [],
        failed: [{ path: 'bad.txt', reason: 'checksum mismatch' }],
      });
    } finally {
      ch.destroy();
    }
    expect(existsSync(join(out, 'bad.txt'))).toBe(false);
    expect(log.join('\n')).toMatch(/failed verification/);
  });

  test('evil manifest paths are rejected with an error message', async () => {
    const out = mkdtempSync(join(tmpdir(), 'es-e2e-out-'));
    const { port } = await withServer(out);
    const { ch, sc } = await openSession(port);
    try {
      await sc.send(FrameType.HEADER, {
        chunkSize: 64,
        files: [{ path: '../evil.txt', size: 1, sha256: sha('x') }],
        dirs: [],
      });
      expect((await sc.recv([FrameType.RESUME])).body).toEqual({
        received: {},
        error: 'unsafe path: "../evil.txt"',
      });
    } finally {
      ch.destroy();
    }
  });

  test('second server on the same port fails to start', async () => {
    const out = mkdtempSync(join(tmpdir(), 'es-e2e-out-'));
    const { port } = await withServer(out);
    await expect(startServer({ port, password: 'x', outDir: out })).rejects.toThrow();
  });

  test('unreachable target fails fast', async () => {
    const src = makeTree();
    const probe = await startServer({ port: 0, password: 'x', outDir: src });
    const deadPort = probe.port;
    await probe.close();
    await expect(
      sendFiles({ host: '127.0.0.1', port: deadPort, password: 'x', path: src }),
    ).rejects.toThrow(expect.objectContaining({ code: 'connect-failed' }));
  });
});
