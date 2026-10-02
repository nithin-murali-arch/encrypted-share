import { createHash } from 'crypto';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync } from 'fs';
import { connect } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { SocketChannel } from '../src/channel';
import { sendFiles } from '../src/index';
import { deriveKey, sealChunk } from '../src/crypto';
import {
  decodeMessage,
  deriveNonce,
  encodeChunk,
  encodeHeader,
  ResumeMessage,
  ResultMessage,
  TransferError,
  TransferHeader,
} from '../src/protocol';
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
    ).rejects.toThrow(TransferError);
    expect(existsSync(join(out, 'a.txt'))).toBe(false);
    expect(log.join('\n')).toMatch(/transfer failed/);
  });

  test('tampered chunk destroys the transfer without landing', async () => {
    const out = mkdtempSync(join(tmpdir(), 'es-e2e-out-'));
    const { port, log } = await withServer(out);
    const socket = connect(port, '127.0.0.1');
    await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
    const ch = new SocketChannel(socket);
    try {
      const salt = Buffer.alloc(16, 9);
      const base = Buffer.alloc(4, 3);
      const key = deriveKey('test-password', salt);
      const header: TransferHeader = {
        salt: salt.toString('base64'),
        baseNonce: base.toString('base64'),
        chunkSize: 64,
        files: [{ path: 'evil.txt', size: 5, sha256: sha('HELLO') }],
        dirs: [],
      };
      await ch.write(encodeHeader(header));
      const resume = decodeMessage<ResumeMessage>(await ch.readFrame());
      expect(resume.error).toBeUndefined();
      const sealed = sealChunk(key, deriveNonce(base, 0n), Buffer.from('HELLO'));
      sealed.ciphertext[0] ^= 0xff;
      await ch.write(encodeChunk(0, 0n, sealed.ciphertext, sealed.tag));
      await expect(ch.readFrame()).rejects.toThrow(TransferError);
    } finally {
      ch.destroy();
    }
    expect(existsSync(join(out, 'evil.txt'))).toBe(false);
    expect(log.join('\n')).toMatch(/transfer failed/);
  });

  test('checksum mismatch yields a failed RESULT, not a crash', async () => {
    const out = mkdtempSync(join(tmpdir(), 'es-e2e-out-'));
    const { port, log } = await withServer(out);
    const socket = connect(port, '127.0.0.1');
    await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
    const ch = new SocketChannel(socket);
    try {
      const salt = Buffer.alloc(16, 9);
      const base = Buffer.alloc(4, 3);
      const key = deriveKey('test-password', salt);
      const header: TransferHeader = {
        salt: salt.toString('base64'),
        baseNonce: base.toString('base64'),
        chunkSize: 64,
        files: [{ path: 'bad.txt', size: 5, sha256: sha('RIGHT') }],
        dirs: [],
      };
      await ch.write(encodeHeader(header));
      await ch.readFrame();
      const sealed = sealChunk(key, deriveNonce(base, 0n), Buffer.from('WRONG'));
      await ch.write(encodeChunk(0, 0n, sealed.ciphertext, sealed.tag));
      await ch.write(Buffer.alloc(4));
      const result = decodeMessage<ResultMessage>(await ch.readFrame());
      expect(result.ok).toBe(false);
      expect(result.failed).toEqual([{ path: 'bad.txt', reason: 'checksum mismatch' }]);
    } finally {
      ch.destroy();
    }
    expect(existsSync(join(out, 'bad.txt'))).toBe(false);
    expect(log.join('\n')).toMatch(/failed verification/);
  });

  test('evil manifest paths are rejected with an error message', async () => {
    const out = mkdtempSync(join(tmpdir(), 'es-e2e-out-'));
    const { port } = await withServer(out);
    const socket = connect(port, '127.0.0.1');
    await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
    const ch = new SocketChannel(socket);
    try {
      const header: TransferHeader = {
        salt: Buffer.alloc(16, 9).toString('base64'),
        baseNonce: Buffer.alloc(4, 3).toString('base64'),
        chunkSize: 64,
        files: [{ path: '../evil.txt', size: 1, sha256: sha('x') }],
        dirs: [],
      };
      await ch.write(encodeHeader(header));
      const resume = decodeMessage<ResumeMessage>(await ch.readFrame());
      expect(resume.error).toMatch(/unsafe path/);
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
