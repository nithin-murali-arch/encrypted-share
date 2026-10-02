import { createHash } from 'crypto';
import { existsSync } from 'fs';
import { promises as fsp } from 'fs';
import { dirname, isAbsolute, join, relative, resolve } from 'path';
import { sha256File } from './crypto';
import { FileEntry, ResultMessage, sanitizePath, TransferError } from './protocol';

export interface StoreOptions {
  outDir: string;
  overwrite?: boolean;
}

export interface StoredFile {
  entry: FileEntry;
  received: number;
}

interface PersistedFileState {
  path: string;
  size: number;
  sha256: string;
  received: number;
}

const STATE_DIR = '.es-partial';
const STATE_FILE = 'state.json';
const SAVE_EVERY_CHUNKS = 8;
const EMPTY_SHA256 = createHash('sha256').digest('hex');

export class PartialStore {
  private readonly outDir: string;
  private readonly overwrite: boolean;
  private files: FileEntry[] = [];
  private dirs: string[] = [];
  private received = new Map<string, number>();
  private chunksSinceSave = 0;

  constructor(opts: StoreOptions) {
    this.outDir = resolve(opts.outDir);
    this.overwrite = opts.overwrite === true;
  }

  private stateDir(): string {
    return join(this.outDir, STATE_DIR);
  }

  private tempPathFor(filePath: string): string {
    const name = createHash('sha256').update(filePath).digest('hex');
    return join(this.stateDir(), `${name}.dat`);
  }

  async prepare(files: FileEntry[], dirs: string[]): Promise<Record<string, number>> {
    for (const f of files) sanitizePath(f.path);
    for (const d of dirs) sanitizePath(d);
    const seen = new Set<string>();
    for (const f of files) {
      if (seen.has(f.path)) {
        throw new TransferError('bad-path', `duplicate path in manifest: ${f.path}`);
      }
      seen.add(f.path);
    }
    await fsp.mkdir(this.stateDir(), { recursive: true });
    this.files = files;
    this.dirs = dirs;

    let prior: PersistedFileState[] = [];
    try {
      const raw = await fsp.readFile(join(this.stateDir(), STATE_FILE), 'utf8');
      const parsed = JSON.parse(raw) as { files?: PersistedFileState[] };
      if (Array.isArray(parsed.files)) prior = parsed.files;
    } catch {
      prior = [];
    }
    const priorByPath = new Map(prior.map((p) => [p.path, p]));

    const out: Record<string, number> = {};
    this.received = new Map();
    for (const f of files) {
      const temp = this.tempPathFor(f.path);
      let resumeBytes = 0;
      const prev = priorByPath.get(f.path);
      if (
        prev &&
        prev.size === f.size &&
        prev.sha256 === f.sha256 &&
        Number.isInteger(prev.received) &&
        prev.received >= 0 &&
        prev.received <= f.size
      ) {
        try {
          const st = await fsp.stat(temp);
          if (st.size > prev.received) {
            await fsp.truncate(temp, prev.received);
            resumeBytes = prev.received;
          } else if (st.size === prev.received) {
            resumeBytes = prev.received;
          } else {
            await fsp.rm(temp, { force: true });
            resumeBytes = 0;
          }
        } catch {
          resumeBytes = 0;
        }
      } else {
        await fsp.rm(temp, { force: true });
      }
      this.received.set(f.path, resumeBytes);
      out[f.path] = resumeBytes;
    }

    await this.pruneStaleTemps(seen);
    await this.saveState();
    return out;
  }

  private async pruneStaleTemps(live: Set<string>): Promise<void> {
    const keep = new Set(
      [...live].map((p) => createHash('sha256').update(p).digest('hex') + '.dat'),
    );
    let entries: string[];
    try {
      entries = await fsp.readdir(this.stateDir());
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.endsWith('.dat') && !keep.has(e)) {
        await fsp.rm(join(this.stateDir(), e), { force: true });
      }
    }
  }

  private async saveState(): Promise<void> {
    const state = {
      files: this.files.map((entry) => ({ ...entry, received: this.received.get(entry.path) ?? 0 })),
      dirs: this.dirs,
    };
    await fsp.writeFile(join(this.stateDir(), STATE_FILE), JSON.stringify(state));
  }

  async append(fileIndex: number, offset: bigint, plaintext: Buffer): Promise<void> {
    if (!Number.isInteger(fileIndex) || fileIndex < 0 || fileIndex >= this.files.length) {
      throw new TransferError('bad-chunk', `file index out of range: ${fileIndex}`);
    }
    const entry = this.files[fileIndex];
    const got = this.received.get(entry.path) ?? 0;
    if (offset !== BigInt(got)) {
      throw new TransferError(
        'non-contiguous',
        `expected offset ${got} for ${entry.path}, got ${offset}`,
      );
    }
    if (plaintext.length === 0) return;
    if (got + plaintext.length > entry.size) {
      throw new TransferError('overflow', `chunk exceeds declared size of ${entry.path}`);
    }
    await fsp.appendFile(this.tempPathFor(entry.path), plaintext);
    this.received.set(entry.path, got + plaintext.length);
    this.chunksSinceSave += 1;
    if (this.chunksSinceSave >= SAVE_EVERY_CHUNKS) {
      this.chunksSinceSave = 0;
      await this.saveState();
    }
  }

  async verifyAndLand(): Promise<ResultMessage> {
    await this.saveState();
    const verified: string[] = [];
    const failed: ResultMessage['failed'] = [];
    for (const d of this.dirs) {
      await fsp.mkdir(join(this.outDir, d), { recursive: true });
    }
    for (const entry of this.files) {
      const got = this.received.get(entry.path) ?? 0;
      if (got !== entry.size) {
        failed.push({ path: entry.path, reason: `incomplete: got ${got} of ${entry.size} bytes` });
        continue;
      }
      const digest =
        entry.size === 0 ? EMPTY_SHA256 : await sha256File(this.tempPathFor(entry.path));
      if (digest !== entry.sha256) {
        failed.push({ path: entry.path, reason: 'checksum mismatch' });
        await fsp.rm(this.tempPathFor(entry.path), { force: true });
        this.received.set(entry.path, 0);
        continue;
      }
      const finalPath = join(this.outDir, entry.path);
      const rel = relative(this.outDir, finalPath);
      if (rel.startsWith('..') || isAbsolute(rel)) {
        failed.push({ path: entry.path, reason: 'path escape rejected' });
        continue;
      }
      if (!this.overwrite && existsSync(finalPath)) {
        failed.push({ path: entry.path, reason: 'already exists (use --overwrite)' });
        continue;
      }
      await fsp.mkdir(dirname(finalPath), { recursive: true });
      if (entry.size === 0) {
        await fsp.writeFile(finalPath, Buffer.alloc(0));
      } else {
        if (this.overwrite) await fsp.rm(finalPath, { force: true });
        await fsp.rename(this.tempPathFor(entry.path), finalPath);
      }
      verified.push(entry.path);
    }
    if (failed.length === 0) {
      await fsp.rm(this.stateDir(), { recursive: true, force: true });
      return { ok: true, verified, failed: [] };
    }
    await this.saveState();
    return { ok: false, verified, failed };
  }

  storedFiles(): StoredFile[] {
    return this.files.map((entry) => ({ entry, received: this.received.get(entry.path) ?? 0 }));
  }
}
