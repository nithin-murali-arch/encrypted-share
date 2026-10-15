import { execFileSync, spawn } from 'child_process';
import type { ChildProcess, ChildProcessByStdio } from 'child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import type { Readable } from 'stream';

jest.setTimeout(60000);

const root = resolve(__dirname, '..');

beforeAll(() => {
  execFileSync(process.execPath, [join(root, 'node_modules', 'typescript', 'bin', 'tsc')], {
    cwd: root,
  });
});

function serve(cwd: string, args: string[]): ChildProcessByStdio<null, Readable, Readable> {
  return spawn(process.execPath, [join(root, 'dist', 'cli.js'), 'serve', ...args], {
    cwd,
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function waitForLine(child: ChildProcess, stream: Readable, text: string): Promise<string> {
  return new Promise((resolveLine, reject) => {
    let buffered = '';
    const timer = setTimeout(
      () => reject(new Error(`no "${text}" line from serve; got: ${buffered}`)),
      20000,
    );
    stream.on('data', (data: Buffer) => {
      buffered += data.toString();
      const line = buffered.split(/\r?\n/).find((l) => l.includes(text));
      if (line !== undefined) {
        clearTimeout(timer);
        resolveLine(line);
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`serve exited with ${code} before "${text}"; got: ${buffered}`));
    });
  });
}

async function stop(child: ChildProcess, dir: string): Promise<void> {
  const exited = new Promise((r) => child.once('exit', r));
  child.kill();
  await exited;
  rmSync(dir, { recursive: true, force: true });
}

describe('encrypted-share serve', () => {
  it('saves to the outputDir from the config file when --out is not given', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'es-cli-')));
    const outputDir = join(dir, 'from-config');
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, JSON.stringify({ key: 'pw', port: 0, outputDir }));
    const child = serve(dir, ['-c', configPath]);
    try {
      const line = await waitForLine(child, child.stdout, 'Saving files to:');
      expect(line).toBe(`Saving files to: ${outputDir}`);
    } finally {
      await stop(child, dir);
    }
  });

  it('prints the address it bound with --host', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'es-cli-')));
    const child = serve(dir, ['--host', '127.0.0.1', '-p', '0', '-k', 'pw', '-o', join(dir, 'out')]);
    try {
      const line = await waitForLine(child, child.stderr, 'Server listening on');
      expect(line).toMatch(/Server listening on 127\.0\.0\.1:\d+$/);
    } finally {
      await stop(child, dir);
    }
  });

  it('binds the host from the config file when --host is not given', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'es-cli-')));
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, JSON.stringify({ key: 'pw', port: 0, host: '127.0.0.1' }));
    const child = serve(dir, ['-c', configPath]);
    try {
      const line = await waitForLine(child, child.stderr, 'Server listening on');
      expect(line).toMatch(/Server listening on 127\.0\.0\.1:\d+$/);
    } finally {
      await stop(child, dir);
    }
  });

  it('prefers --host over the host in the config file', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'es-cli-')));
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, JSON.stringify({ key: 'pw', port: 0, host: '0.0.0.0' }));
    const child = serve(dir, ['-c', configPath, '--host', '127.0.0.1']);
    try {
      const line = await waitForLine(child, child.stderr, 'Server listening on');
      expect(line).toMatch(/Server listening on 127\.0\.0\.1:\d+$/);
    } finally {
      await stop(child, dir);
    }
  });
});
