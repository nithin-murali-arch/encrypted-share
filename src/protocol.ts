export const MAGIC = Buffer.from('ES03', 'ascii');
export const LEGACY_MAGIC = Buffer.from('ES02', 'ascii');
export const VERSION = 3;
export const HELLO_PREFIX_LENGTH = 6;
export const SALT_LENGTH = 16;
export const SERVER_NONCE_LENGTH = 16;
export const HELLO_LENGTH = HELLO_PREFIX_LENGTH + SALT_LENGTH;
export const NONCE_LENGTH = 12;
export const TAG_LENGTH = 16;
export const KEY_LENGTH = 32;
export const DEFAULT_CHUNK_SIZE = 64 * 1024;
export const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
export const MAX_CHUNK_BYTES = 4 * 1024 * 1024;

const CHUNK_BODY_PREFIX_LENGTH = 4 + 8;
export const CHUNK_FRAME_OVERHEAD = 1 + CHUNK_BODY_PREFIX_LENGTH + TAG_LENGTH;

export const FRAME_AAD = Buffer.alloc(HELLO_PREFIX_LENGTH);
MAGIC.copy(FRAME_AAD, 0);
FRAME_AAD.writeUInt16BE(VERSION, 4);

export interface FileEntry {
  path: string;
  size: number;
  sha256: string;
}

export interface TransferHeader {
  chunkSize: number;
  files: FileEntry[];
  dirs: string[];
}

export interface ResumeMessage {
  received: Record<string, number>;
  error?: string;
}

export interface FailedFile {
  path: string;
  reason: string;
}

export interface ResultMessage {
  ok: boolean;
  verified: string[];
  failed: FailedFile[];
}

export interface ChunkBody {
  fileIndex: number;
  offset: bigint;
  data: Buffer;
}

export enum FrameType {
  HEADER = 1,
  RESUME = 2,
  CHUNK = 3,
  DONE = 4,
  RESULT = 5,
}

export interface FrameBodies {
  [FrameType.HEADER]: TransferHeader;
  [FrameType.RESUME]: ResumeMessage;
  [FrameType.CHUNK]: ChunkBody;
  [FrameType.DONE]: null;
  [FrameType.RESULT]: ResultMessage;
}

export type Frame<T extends FrameType = FrameType> = {
  [K in T]: { type: K; body: FrameBodies[K] };
}[T];

export class TransferError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'TransferError';
    this.code = code;
  }
}

export class FrameReader {
  private chunks: Buffer[] = [];
  private length = 0;

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.length += chunk.length;
  }

  take(bytes: number): Buffer | null {
    if (this.length < bytes) return null;
    return this.consume(bytes);
  }

  takeFrame(maxBytes: number = MAX_MESSAGE_BYTES): Buffer | null {
    if (this.length < 4) return null;
    const len = this.head(4).readUInt32BE(0);
    if (len > maxBytes) {
      throw new TransferError('frame-too-large', `frame declares ${len} bytes (max ${maxBytes})`);
    }
    if (this.length < 4 + len) return null;
    return this.consume(4 + len).subarray(4);
  }

  get buffered(): number {
    return this.length;
  }

  // Joins chunks only once a read can be served, so a frame that arrives in
  // many socket chunks is copied once instead of once per chunk.
  private head(bytes: number): Buffer {
    if (this.chunks[0].length < bytes) {
      let count = 1;
      let joined = this.chunks[0].length;
      while (joined < bytes) joined += this.chunks[count++].length;
      this.chunks.splice(0, count, Buffer.concat(this.chunks.slice(0, count), joined));
    }
    return this.chunks[0];
  }

  private consume(bytes: number): Buffer {
    const first = this.head(bytes);
    if (first.length === bytes) this.chunks.shift();
    else this.chunks[0] = first.subarray(bytes);
    this.length -= bytes;
    return first.subarray(0, bytes);
  }
}

export type HelloKind = 'current' | 'legacy';

export function parseHelloPrefix(prefix: Buffer): HelloKind {
  const magic = prefix.subarray(0, 4);
  if (magic.equals(LEGACY_MAGIC)) return 'legacy';
  if (!magic.equals(MAGIC)) {
    throw new TransferError('bad-hello', `unknown protocol magic ${JSON.stringify(magic.toString('latin1'))}`);
  }
  const version = prefix.readUInt16BE(4);
  if (version !== VERSION) {
    throw new TransferError('bad-hello', `unsupported ES03 version ${version}`);
  }
  return 'current';
}

export function encodeHello(random: Buffer): Buffer {
  const out = Buffer.alloc(HELLO_LENGTH);
  FRAME_AAD.copy(out, 0);
  random.copy(out, HELLO_PREFIX_LENGTH);
  return out;
}

export function decodeHello(hello: Buffer): Buffer {
  if (parseHelloPrefix(hello) !== 'current') {
    throw new TransferError('bad-hello', 'peer speaks the ES02 protocol');
  }
  return hello.subarray(HELLO_PREFIX_LENGTH, HELLO_LENGTH);
}

export function encodeLegacyRejection(error: string): Buffer {
  const json = Buffer.from(JSON.stringify({ received: {}, error } satisfies ResumeMessage), 'utf8');
  const out = Buffer.alloc(4 + json.length);
  out.writeUInt32BE(json.length, 0);
  json.copy(out, 4);
  return out;
}

function parseJson(buf: Buffer): unknown {
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw new TransferError('bad-message', 'message is not valid JSON');
  }
}

function assertHeaderShape(obj: unknown): TransferHeader {
  if (typeof obj !== 'object' || obj === null) {
    throw new TransferError('bad-header', 'header is not an object');
  }
  const h = obj as Record<string, unknown>;
  if (!Number.isInteger(h['chunkSize']) || (h['chunkSize'] as number) <= 0) {
    throw new TransferError('bad-header', 'header chunkSize must be a positive integer');
  }
  if (!Array.isArray(h['files']) || !Array.isArray(h['dirs'])) {
    throw new TransferError('bad-header', 'header files/dirs must be arrays');
  }
  for (const f of h['files']) {
    const e = f as Record<string, unknown>;
    if (
      typeof e?.['path'] !== 'string' ||
      !Number.isInteger(e?.['size']) ||
      (e?.['size'] as number) < 0 ||
      typeof e?.['sha256'] !== 'string'
    ) {
      throw new TransferError('bad-header', 'header file entry malformed');
    }
  }
  return obj as TransferHeader;
}

interface BodyCodec<T> {
  encode(body: T): Buffer;
  decode(buf: Buffer): T;
}

function jsonCodec<T>(check: (obj: unknown) => T): BodyCodec<T> {
  return {
    encode: (body) => Buffer.from(JSON.stringify(body), 'utf8'),
    decode: (buf) => check(parseJson(buf)),
  };
}

const chunkCodec: BodyCodec<ChunkBody> = {
  encode: ({ fileIndex, offset, data }) => {
    const out = Buffer.alloc(CHUNK_BODY_PREFIX_LENGTH + data.length);
    out.writeUInt32BE(fileIndex, 0);
    out.writeBigUInt64BE(offset, 4);
    data.copy(out, CHUNK_BODY_PREFIX_LENGTH);
    return out;
  },
  decode: (buf) => {
    if (buf.length < CHUNK_BODY_PREFIX_LENGTH) {
      throw new TransferError('bad-chunk', 'chunk frame too short');
    }
    return {
      fileIndex: buf.readUInt32BE(0),
      offset: buf.readBigUInt64BE(4),
      data: buf.subarray(CHUNK_BODY_PREFIX_LENGTH),
    };
  },
};

const doneCodec: BodyCodec<null> = {
  encode: () => Buffer.alloc(0),
  decode: (buf) => {
    if (buf.length !== 0) throw new TransferError('bad-frame', 'DONE frame carries a body');
    return null;
  },
};

const BODY_CODECS: { [K in FrameType]: BodyCodec<FrameBodies[K]> } = {
  [FrameType.HEADER]: jsonCodec(assertHeaderShape),
  [FrameType.RESUME]: jsonCodec((obj) => obj as ResumeMessage),
  [FrameType.CHUNK]: chunkCodec,
  [FrameType.DONE]: doneCodec,
  [FrameType.RESULT]: jsonCodec((obj) => obj as ResultMessage),
};

function frameName(type: number): string {
  return FrameType[type] ?? `type ${type}`;
}

export function encodeFrame<T extends FrameType>(type: T, body: FrameBodies[T]): Buffer {
  const codec = BODY_CODECS[type] as BodyCodec<FrameBodies[T]>;
  return Buffer.concat([Buffer.from([type]), codec.encode(body)]);
}

export function decodeFrame<T extends FrameType>(plaintext: Buffer, expected: readonly T[]): Frame<T> {
  const type = plaintext.length > 0 ? plaintext[0] : -1;
  if (!(expected as readonly number[]).includes(type)) {
    throw new TransferError(
      'bad-frame',
      `expected ${expected.map(frameName).join(' or ')}, got ${type === -1 ? 'an empty frame' : frameName(type)}`,
    );
  }
  const codec = BODY_CODECS[type as T] as BodyCodec<FrameBodies[T]>;
  return { type, body: codec.decode(plaintext.subarray(1)) } as Frame<T>;
}

export function sanitizePath(p: string): string {
  if (typeof p !== 'string' || p.length === 0) {
    throw new TransferError('bad-path', 'empty path');
  }
  if (p.includes('\0')) {
    throw new TransferError('bad-path', 'path contains NUL');
  }
  const norm = p.replace(/\\/g, '/');
  if (norm.startsWith('/') || /^[A-Za-z]:/.test(norm)) {
    throw new TransferError('bad-path', `absolute path rejected: ${JSON.stringify(p)}`);
  }
  const segs = norm.split('/');
  for (const s of segs) {
    if (s === '' || s === '.' || s === '..') {
      throw new TransferError('bad-path', `unsafe path: ${JSON.stringify(p)}`);
    }
  }
  return segs.join('/');
}
