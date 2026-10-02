import {
  FrameReader,
  TransferError,
  VERSION,
  decodeChunk,
  decodeHeader,
  decodeMessage,
  deriveNonce,
  encodeChunk,
  encodeHeader,
  encodeMessage,
  readHeaderLength,
  sanitizePath,
  TransferHeader,
} from '../src/protocol';

function sampleHeader(): TransferHeader {
  return {
    salt: Buffer.alloc(16, 1).toString('base64'),
    baseNonce: Buffer.alloc(4, 2).toString('base64'),
    chunkSize: 65536,
    files: [{ path: 'a.txt', size: 3, sha256: 'abc' }],
    dirs: ['sub'],
  };
}

describe('header codec', () => {
  test('round-trip', () => {
    const h = sampleHeader();
    expect(decodeHeader(encodeHeader(h))).toEqual(h);
  });

  test('rejects bad magic', () => {
    const buf = encodeHeader(sampleHeader());
    buf.write('XXXX', 0);
    expect(() => decodeHeader(buf)).toThrow(TransferError);
  });

  test('rejects bad version', () => {
    const buf = encodeHeader(sampleHeader());
    buf.writeUInt16BE(VERSION + 1, 4);
    expect(() => decodeHeader(buf)).toThrow(/version/);
  });

  test('rejects length mismatch and truncation', () => {
    const buf = encodeHeader(sampleHeader());
    buf.writeUInt32BE(buf.length, 6);
    expect(() => decodeHeader(buf)).toThrow(/mismatch/);
    expect(() => decodeHeader(buf.subarray(0, 5))).toThrow(/too short/);
  });

  test('rejects non-JSON and malformed shapes', () => {
    const raw = Buffer.from('not json');
    const buf = Buffer.alloc(10 + raw.length);
    buf.write('ES02', 0);
    buf.writeUInt16BE(VERSION, 4);
    buf.writeUInt32BE(raw.length, 6);
    raw.copy(buf, 10);
    expect(() => decodeHeader(buf)).toThrow(/JSON/);
    const badShapes = [
      { ...sampleHeader(), files: 'nope' },
      { ...sampleHeader(), dirs: {} },
      { ...sampleHeader(), chunkSize: 0 },
      { ...sampleHeader(), files: [{ path: 'x' }] },
    ];
    for (const s of badShapes) {
      const json = Buffer.from(JSON.stringify(s));
      const b = Buffer.alloc(10 + json.length);
      b.write('ES02', 0);
      b.writeUInt16BE(VERSION, 4);
      b.writeUInt32BE(json.length, 6);
      json.copy(b, 10);
      expect(() => decodeHeader(b)).toThrow(TransferError);
    }
  });

  test('readHeaderLength extracts declared length', () => {
    const buf = encodeHeader(sampleHeader());
    expect(readHeaderLength(buf.subarray(0, 10))).toBe(buf.length - 10);
    expect(() => readHeaderLength(buf.subarray(0, 9))).toThrow(TransferError);
  });
});

describe('message codec', () => {
  test('round-trip', () => {
    const msg = { ok: true, verified: ['a'], failed: [] };
    const framed = encodeMessage(msg);
    expect(framed.readUInt32BE(0)).toBe(framed.length - 4);
    expect(decodeMessage(framed.subarray(4))).toEqual(msg);
  });

  test('rejects bad JSON', () => {
    expect(() => decodeMessage(Buffer.from('{{{'))).toThrow(/JSON/);
  });
});

describe('chunk codec', () => {
  test('round-trip', () => {
    const ct = Buffer.from('ciphertext-bytes');
    const tag = Buffer.alloc(16, 7);
    const frame = encodeChunk(3, 123456789n, ct, tag);
    expect(frame.readUInt32BE(0)).toBe(frame.length - 4);
    const { header, ciphertext, tag: tagOut } = decodeChunk(frame.subarray(4));
    expect(header).toEqual({ fileIndex: 3, offset: 123456789n, dataLength: ct.length });
    expect(ciphertext.equals(ct)).toBe(true);
    expect(tagOut.equals(tag)).toBe(true);
  });

  test('rejects short frames, length mismatch, bad tag', () => {
    expect(() => decodeChunk(Buffer.alloc(10))).toThrow(/too short/);
    const ct = Buffer.from('x');
    const frame = encodeChunk(0, 0n, ct, Buffer.alloc(16));
    const payload = Buffer.from(frame.subarray(4));
    payload.writeUInt32BE(999, 12);
    expect(() => decodeChunk(payload)).toThrow(/mismatch/);
    expect(() => encodeChunk(-1, 0n, ct, Buffer.alloc(16))).toThrow(TransferError);
    expect(() => encodeChunk(0, 0n, ct, Buffer.alloc(8))).toThrow(/tag/);
  });
});

describe('FrameReader', () => {
  test('accumulates partial pushes and takes exact bytes', () => {
    const r = new FrameReader();
    expect(r.take(1)).toBeNull();
    r.push(Buffer.from([1, 2]));
    expect(r.buffered).toBe(2);
    expect(r.take(3)).toBeNull();
    r.push(Buffer.from([3, 4, 5]));
    expect(r.take(3)).toEqual(Buffer.from([1, 2, 3]));
    expect(r.buffered).toBe(2);
  });

  test('takeFrame waits for full frame and handles DONE marker', () => {
    const r = new FrameReader();
    const frame = encodeMessage({ hello: 'world' });
    r.push(frame.subarray(0, 5));
    expect(r.takeFrame()).toBeNull();
    r.push(frame.subarray(5));
    expect(decodeMessage(r.takeFrame()!)).toEqual({ hello: 'world' });
    expect(r.takeFrame()).toBeNull();
    r.push(Buffer.alloc(4));
    const done = r.takeFrame();
    expect(done).not.toBeNull();
    expect(done!.length).toBe(0);
  });

  test('rejects oversized frames', () => {
    const r = new FrameReader();
    const len = Buffer.alloc(4);
    len.writeUInt32BE(1024, 0);
    r.push(len);
    try {
      r.takeFrame(16);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(TransferError);
      expect((err as TransferError).code).toBe('frame-too-large');
    }
  });
});

describe('deriveNonce', () => {
  test('builds 12-byte nonce with counter suffix', () => {
    const base = Buffer.from([1, 2, 3, 4]);
    const n0 = deriveNonce(base, 0n);
    const n1 = deriveNonce(base, 1n);
    expect(n0.length).toBe(12);
    expect(n0.subarray(0, 4).equals(base)).toBe(true);
    expect(n0.readBigUInt64BE(4)).toBe(0n);
    expect(n1.readBigUInt64BE(4)).toBe(1n);
    expect(n0.equals(n1)).toBe(false);
  });

  test('rejects bad base length', () => {
    expect(() => deriveNonce(Buffer.alloc(12), 0n)).toThrow(/base nonce/);
  });
});

describe('sanitizePath', () => {
  test('accepts safe relative paths', () => {
    expect(sanitizePath('a.txt')).toBe('a.txt');
    expect(sanitizePath('sub/dir/b.txt')).toBe('sub/dir/b.txt');
  });

  test('rejects evil paths', () => {
    for (const evil of [
      '',
      '/abs/path',
      'C:/win',
      'C:\\win',
      '../escape',
      'a/../../escape',
      'a//b',
      'a/./b',
      'trailing/',
      'nul\0byte',
    ]) {
      expect(() => sanitizePath(evil)).toThrow(TransferError);
    }
  });
});
