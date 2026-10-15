import { execFileSync, spawn } from 'child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

jest.setTimeout(60000);

const root = resolve(__dirname, '..');

beforeAll(() => {
  execFileSync(process.execPath, [join(root, 'node_modules', 'typescript', 'bin', 'tsc')], {
    cwd: root,
  });
});

function waitForLine(child: ReturnType<typeof spawn>, prefix: string): Promise<string> {
  return new Promise((resolveLine, reject) => {
    let buffered = '';
    const timer = setTimeout(
      () => reject(new Error(`no "${prefix}" line from serve; got: ${buffered}`)),
      20000,
    );
    child.stdout!.on('data', (data: Buffer) => {
      buffered += data.toString();
      const line = buffered.split(/\r?\n/).find((l) => l.startsWith(prefix));
      if (line !== undefined) {
        clearTimeout(timer);
        resolveLine(line);
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`serve exited with ${code} before "${prefix}"; got: ${buffered}`));
    });
  });
}

describe('encrypted-share serve', () => {
  it('saves to the outputDir from the config file when --out is not given', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'es-cli-')));
    const outputDir = join(dir, 'from-config');
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, JSON.stringify({ key: 'pw', port: 0, outputDir }));
    const child = spawn(process.execPath, [join(root, 'dist', 'cli.js'), 'serve', '-c', configPath], {
      cwd: dir,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      const line = await waitForLine(child, 'Saving files to:');
      expect(line).toBe(`Saving files to: ${outputDir}`);
    } finally {
      const exited = new Promise((r) => child.once('exit', r));
      child.kill();
      await exited;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
