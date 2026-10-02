import { createHash } from 'crypto';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildManifest } from '../src/manifest';
import { TransferError } from '../src/protocol';

function sha(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

describe('buildManifest', () => {
  test('single file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'es-man-'));
    const f = join(dir, 'one.txt');
    writeFileSync(f, 'ONE');
    const m = await buildManifest(f);
    expect(m.files).toEqual([{ path: 'one.txt', size: 3, sha256: sha('ONE') }]);
    expect(m.dirs).toEqual([]);
    expect(m.totalBytes).toBe(3);
  });

  test('directory with nesting and empty dir', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'es-man-'));
    writeFileSync(join(dir, 'a.txt'), 'AAA');
    mkdirSync(join(dir, 'sub', 'empty'), { recursive: true });
    writeFileSync(join(dir, 'sub', 'b.txt'), 'BBBB');
    const m = await buildManifest(dir);
    expect(m.files.map((e) => e.path).sort()).toEqual(['a.txt', 'sub/b.txt']);
    expect(m.dirs.sort()).toEqual(['sub', 'sub/empty']);
    expect(m.totalBytes).toBe(7);
    expect(m.files.find((e) => e.path === 'sub/b.txt')!.sha256).toBe(sha('BBBB'));
  });

  test('missing path throws not-found', async () => {
    try {
      await buildManifest(join(tmpdir(), 'es-no-such-dir-xyz'));
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as TransferError).code).toBe('not-found');
    }
  });

  test('non-file non-dir throws not-supported', async () => {
    try {
      await buildManifest('/dev/null');
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as TransferError).code).toBe('not-supported');
    }
  });

  test('skips symlinks with a warning', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'es-man-'));
    writeFileSync(join(dir, 'real.txt'), 'R');
    symlinkSync(join(dir, 'real.txt'), join(dir, 'link.txt'));
    const warnings: string[] = [];
    const m = await buildManifest(dir, (w) => warnings.push(w));
    expect(m.files.map((e) => e.path)).toEqual(['real.txt']);
    expect(warnings.join('\n')).toMatch(/symlink/);
  });
});
