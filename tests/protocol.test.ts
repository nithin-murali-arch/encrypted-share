import {
  decodeFrame,
  decodeHello,
  encodeFrame,
  encodeHello,
  encodeLegacyRejection,
  FrameReader,
  FrameType,
  parseHelloPrefix,
  sanitizePath,
  TransferError,
  TransferHeader,
} from '../src/protocol';

function sampleHeader(): TransferHeader {
  return {
    chunkSize: 65536,
    files: [{ path: 'a.txt', size: 3, sha256: 'abc' }],
    dirs: ['sub'],
  };
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(TransferError);
    return (err as TransferError).code;
  }
  throw new Error('expected a TransferError');
}

function headerFrame(obj: unknown): Buffer {
  return Buffer.concat([Buffer.from([FrameType.HEADER]), Buffer.from(JSON.stringify(obj))]);
}

describe('hello codec', () => {
  test('encodes magic, version and the 16 random bytes', () => {
    const random = Buffer.alloc(16, 0xab);
    const hello = encodeHello(random);
    expect(hello.toString('hex')).toBe('45533033' + '0003' + 'ab'.repeat(16));
    expect(decodeHello(hello).equals(random)).toBe(true);
  });

  test('classifies the ES02 magic as legacy', () => {
    expect(parseHelloPrefix(Buffer.from('4553303200020000', 'hex'))).toBe('legacy');
    expect(parseHelloPrefix(Buffer.from('455330330003', 'hex'))).toBe('current');
  });

  test('rejects unknown magic and unsupported version', () => {
    expect(() => parseHelloPrefix(Buffer.from('HTTP/1', 'latin1'))).toThrow(
      'unknown protocol magic "HTTP"',
    );
    expect(() => parseHelloPrefix(Buffer.from('455330330004', 'hex'))).toThrow(
      'unsupported ES03 version 4',
    );
    expect(codeOf(() => decodeHello(Buffer.concat([Buffer.from('ES02'), Buffer.alloc(18)])))).toBe(
      'bad-hello',
    );
  });
});

describe('frame codec', () => {
  test('HEADER round-trip', () => {
    const plaintext = encodeFrame(FrameType.HEADER, sampleHeader());
    expect(plaintext[0]).toBe(1);
    expect(decodeFrame(plaintext, [FrameType.HEADER])).toEqual({
      type: FrameType.HEADER,
      body: sampleHeader(),
    });
  });

  test('CHUNK carries fileIndex and offset in the plaintext', () => {
    const plaintext = encodeFrame(FrameType.CHUNK, {
      fileIndex: 3,
      offset: 123456789n,
      data: Buffer.from('xyz'),
    });
    expect(plaintext.toString('hex')).toBe('03' + '00000003' + '00000000075bcd15' + '78797a');
    expect(decodeFrame(plaintext, [FrameType.CHUNK, FrameType.DONE])).toEqual({
      type: FrameType.CHUNK,
      body: { fileIndex: 3, offset: 123456789n, data: Buffer.from('xyz') },
    });
  });

  test('DONE is a bare type byte', () => {
    expect(encodeFrame(FrameType.DONE, null)).toEqual(Buffer.from([4]));
    expect(decodeFrame(Buffer.from([4]), [FrameType.CHUNK, FrameType.DONE])).toEqual({
      type: FrameType.DONE,
      body: null,
    });
    expect(codeOf(() => decodeFrame(Buffer.from([4, 0]), [FrameType.DONE]))).toBe('bad-frame');
  });

  test('RESUME and RESULT round-trip as JSON', () => {
    const resume = { received: { 'a.txt': 2 } };
    expect(decodeFrame(encodeFrame(FrameType.RESUME, resume), [FrameType.RESUME]).body).toEqual(resume);
    const result = { ok: false, verified: ['a'], failed: [{ path: 'b', reason: 'checksum mismatch' }] };
    expect(decodeFrame(encodeFrame(FrameType.RESULT, result), [FrameType.RESULT]).body).toEqual(result);
  });

  test('rejects a frame type the sequence does not expect', () => {
    const result = encodeFrame(FrameType.RESULT, { ok: true, verified: [], failed: [] });
    expect(() => decodeFrame(result, [FrameType.HEADER])).toThrow('expected HEADER, got RESULT');
    expect(() => decodeFrame(Buffer.from([99]), [FrameType.CHUNK, FrameType.DONE])).toThrow(
      'expected CHUNK or DONE, got type 99',
    );
    expect(codeOf(() => decodeFrame(Buffer.alloc(0), [FrameType.HEADER]))).toBe('bad-frame');
  });

  test('rejects a short CHUNK body', () => {
    expect(() => decodeFrame(Buffer.from([3, 0, 0, 0]), [FrameType.CHUNK])).toThrow(/too short/);
  });

  test('rejects non-JSON and malformed headers', () => {
    const notJson = Buffer.concat([Buffer.from([FrameType.HEADER]), Buffer.from('not json')]);
    expect(() => decodeFrame(notJson, [FrameType.HEADER])).toThrow(/JSON/);
    const badShapes = [
      null,
      { ...sampleHeader(), files: 'nope' },
      { ...sampleHeader(), dirs: {} },
      { ...sampleHeader(), chunkSize: 0 },
      { ...sampleHeader(), files: [{ path: 'x' }] },
    ];
    for (const s of badShapes) {
      expect(codeOf(() => decodeFrame(headerFrame(s), [FrameType.HEADER]))).toBe('bad-header');
    }
  });
});

describe('legacy rejection', () => {
  test('is an ES02 RESUME frame with an error', () => {
    const frame = encodeLegacyRejection('upgrade');
    expect(frame.readUInt32BE(0)).toBe(frame.length - 4);
    expect(JSON.parse(frame.subarray(4).toString('utf8'))).toEqual({ received: {}, error: 'upgrade' });
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

  test('takeFrame waits for the full frame', () => {
    const r = new FrameReader();
    const frame = Buffer.from('00000003616263' + '00000000', 'hex');
    r.push(frame.subarray(0, 5));
    expect(r.takeFrame()).toBeNull();
    r.push(frame.subarray(5));
    expect(r.takeFrame()).toEqual(Buffer.from('abc'));
    expect(r.takeFrame()).toEqual(Buffer.alloc(0));
    expect(r.takeFrame()).toBeNull();
  });

  test('assembles a frame from many chunks and keeps the bytes that follow it', () => {
    const r = new FrameReader();
    const body = Buffer.alloc(4 * 1024 * 1024);
    for (let i = 0; i < body.length; i++) body[i] = i % 251;
    const stream = Buffer.concat([Buffer.from([0, 0x40, 0, 0]), body, Buffer.from('00000002', 'hex')]);
    r.push(stream.subarray(0, 1));
    expect(r.takeFrame(body.length)).toBeNull();
    for (let at = 1; at < stream.length; at += 64 * 1024) r.push(stream.subarray(at, at + 64 * 1024));
    expect(r.takeFrame(body.length)?.equals(body)).toBe(true);
    expect(r.buffered).toBe(4);
    expect(r.takeFrame()).toBeNull();
    r.push(Buffer.from('7879', 'hex'));
    expect(r.takeFrame()).toEqual(Buffer.from('xy'));
    expect(r.buffered).toBe(0);
  });

  test('rejects oversized frames', () => {
    const r = new FrameReader();
    const len = Buffer.alloc(4);
    len.writeUInt32BE(1024, 0);
    r.push(len);
    expect(codeOf(() => r.takeFrame(16))).toBe('frame-too-large');
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
