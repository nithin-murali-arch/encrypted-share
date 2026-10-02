export const MAGIC = Buffer.from('ES02', 'ascii');
export const VERSION = 2;
export const HEADER_PREFIX_LENGTH = 10;
export const IV_BASE_LENGTH = 4;
export const NONCE_LENGTH = 12;
export const TAG_LENGTH = 16;
export const SALT_LENGTH = 16;
export const KEY_LENGTH = 32;
export const DEFAULT_CHUNK_SIZE = 64 * 1024;
export const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
export const MAX_CHUNK_BYTES = 4 * 1024 * 1024;

export interface FileEntry {
  path: string;
  size: number;
  sha256: string;
}

export interface TransferHeader {
  salt: string;
  baseNonce: string;
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

export interface ChunkHeader {
  fileIndex: number;
  offset: bigint;
  dataLength: number;
}

export class TransferError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'TransferError';
    this.code = code;
  }
}

export class FrameReader {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): void {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
  }

  take(bytes: number): Buffer | null {
    if (this.buf.length < bytes) return null;
    const out = this.buf.subarray(0, bytes);
    this.buf = this.buf.subarray(bytes);
    return out;
  }

  takeFrame(maxBytes: number = MAX_MESSAGE_BYTES): Buffer | null {
    if (this.buf.length < 4) return null;
    const len = this.buf.readUInt32BE(0);
    if (len > maxBytes) {
      throw new TransferError('frame-too-large', `frame declares ${len} bytes (max ${maxBytes})`);
    }
    if (this.buf.length < 4 + len) return null;
    const out = this.buf.subarray(4, 4 + len);
    this.buf = this.buf.subarray(4 + len);
    return out;
  }

  get buffered(): number {
    return this.buf.length;
  }
}

function assertHeaderShape(obj: unknown): TransferHeader {
  if (typeof obj !== 'object' || obj === null) {
    throw new TransferError('bad-header', 'header is not an object');
  }
  const h = obj as Record<string, unknown>;
  if (typeof h['salt'] !== 'string' || typeof h['baseNonce'] !== 'string') {
    throw new TransferError('bad-header', 'header salt/baseNonce must be strings');
  }
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

export function encodeHeader(header: TransferHeader): Buffer {
  const json = Buffer.from(JSON.stringify(header), 'utf8');
  const out = Buffer.alloc(HEADER_PREFIX_LENGTH + json.length);
  MAGIC.copy(out, 0);
  out.writeUInt16BE(VERSION, 4);
  out.writeUInt32BE(json.length, 6);
  json.copy(out, HEADER_PREFIX_LENGTH);
  return out;
}

export function decodeHeader(buf: Buffer): TransferHeader {
  if (buf.length < HEADER_PREFIX_LENGTH) {
    throw new TransferError('bad-header', 'header too short');
  }
  if (!buf.subarray(0, 4).equals(MAGIC)) {
    throw new TransferError('bad-header', 'bad magic');
  }
  const version = buf.readUInt16BE(4);
  if (version !== VERSION) {
    throw new TransferError('bad-header', `unsupported version ${version}`);
  }
  const len = buf.readUInt32BE(6);
  if (len > MAX_MESSAGE_BYTES) {
    throw new TransferError('bad-header', `header length ${len} exceeds max`);
  }
  if (buf.length !== HEADER_PREFIX_LENGTH + len) {
    throw new TransferError('bad-header', 'header length mismatch');
  }
  let obj: unknown;
  try {
    obj = JSON.parse(buf.subarray(HEADER_PREFIX_LENGTH).toString('utf8'));
  } catch {
    throw new TransferError('bad-header', 'header is not valid JSON');
  }
  return assertHeaderShape(obj);
}

export function readHeaderLength(prefix: Buffer): number {
  if (prefix.length < HEADER_PREFIX_LENGTH) {
    throw new TransferError('bad-header', 'header prefix too short');
  }
  if (!prefix.subarray(0, 4).equals(MAGIC)) {
    throw new TransferError('bad-header', 'bad magic');
  }
  const len = prefix.readUInt32BE(6);
  if (len > MAX_MESSAGE_BYTES) {
    throw new TransferError('bad-header', `header length ${len} exceeds max`);
  }
  return len;
}

export function encodeMessage(obj: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(obj), 'utf8');
  const out = Buffer.alloc(4 + json.length);
  out.writeUInt32BE(json.length, 0);
  json.copy(out, 4);
  return out;
}

export function decodeMessage<T>(buf: Buffer): T {
  try {
    return JSON.parse(buf.toString('utf8')) as T;
  } catch {
    throw new TransferError('bad-message', 'message is not valid JSON');
  }
}

export function encodeChunk(
  fileIndex: number,
  offset: bigint,
  ciphertext: Buffer,
  tag: Buffer,
): Buffer {
  if (!Number.isInteger(fileIndex) || fileIndex < 0) {
    throw new TransferError('bad-chunk', 'fileIndex must be a non-negative integer');
  }
  if (tag.length !== TAG_LENGTH) {
    throw new TransferError('bad-chunk', 'tag must be 16 bytes');
  }
  const payloadLen = 4 + 8 + 4 + ciphertext.length + TAG_LENGTH;
  const out = Buffer.alloc(4 + payloadLen);
  out.writeUInt32BE(payloadLen, 0);
  out.writeUInt32BE(fileIndex, 4);
  out.writeBigUInt64BE(offset, 8);
  out.writeUInt32BE(ciphertext.length, 16);
  ciphertext.copy(out, 20);
  tag.copy(out, 20 + ciphertext.length);
  return out;
}

export function decodeChunk(frame: Buffer): {
  header: ChunkHeader;
  ciphertext: Buffer;
  tag: Buffer;
} {
  if (frame.length < 32) {
    throw new TransferError('bad-chunk', 'chunk frame too short');
  }
  const fileIndex = frame.readUInt32BE(0);
  const offset = frame.readBigUInt64BE(4);
  const dataLength = frame.readUInt32BE(12);
  if (frame.length !== 16 + dataLength + TAG_LENGTH) {
    throw new TransferError('bad-chunk', 'chunk length mismatch');
  }
  return {
    header: { fileIndex, offset, dataLength },
    ciphertext: frame.subarray(16, 16 + dataLength),
    tag: frame.subarray(16 + dataLength),
  };
}

export function deriveNonce(baseNonce: Buffer, counter: bigint): Buffer {
  if (baseNonce.length !== IV_BASE_LENGTH) {
    throw new TransferError('bad-nonce', 'base nonce must be 4 bytes');
  }
  const out = Buffer.alloc(NONCE_LENGTH);
  baseNonce.copy(out, 0);
  out.writeBigUInt64BE(counter, IV_BASE_LENGTH);
  return out;
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
