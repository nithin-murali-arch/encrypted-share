import { readdirSync, statSync } from 'fs';
import { basename, dirname, join, relative, resolve, sep } from 'path';
import { sha256File } from './crypto';
import { FileEntry, TransferError } from './protocol';

export interface Manifest {
  root: string;
  files: FileEntry[];
  dirs: string[];
  totalBytes: number;
}

export type WarnFn = (message: string) => void;

function toPosix(p: string): string {
  return p.split(sep).join('/');
}

export async function buildManifest(targetPath: string, onWarn?: WarnFn): Promise<Manifest> {
  const resolved = resolve(targetPath);
  let st;
  try {
    st = statSync(resolved);
  } catch {
    throw new TransferError('not-found', `no such file or directory: ${targetPath}`);
  }

  if (st.isFile()) {
    const sha256 = await sha256File(resolved);
    return {
      root: dirname(resolved),
      files: [{ path: basename(resolved), size: st.size, sha256 }],
      dirs: [],
      totalBytes: st.size,
    };
  }
  if (!st.isDirectory()) {
    throw new TransferError('not-supported', `not a file or directory: ${targetPath}`);
  }

  const files: FileEntry[] = [];
  const dirs: string[] = [];
  const pending: Array<{ rel: string; full: string }> = [];

  const walk = (dir: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const e of entries) {
      const full = join(dir, e.name);
      const rel = toPosix(relative(resolved, full));
      if (e.isSymbolicLink()) {
        onWarn?.(`skipping symlink: ${rel}`);
        continue;
      }
      if (e.isDirectory()) {
        dirs.push(rel);
        walk(full);
      } else if (e.isFile()) {
        pending.push({ rel, full });
      } else {
        onWarn?.(`skipping special file: ${rel}`);
      }
    }
  };
  walk(resolved);

  let totalBytes = 0;
  for (const { rel, full } of pending) {
    const size = statSync(full).size;
    const sha256 = await sha256File(full);
    files.push({ path: rel, size, sha256 });
    totalBytes += size;
  }
  return { root: resolved, files, dirs, totalBytes };
}
