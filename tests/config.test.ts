import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadConfig, DEFAULT_CONFIG_PATH } from '../src/config';

describe('loadConfig', () => {
  test('missing file yields empty config', () => {
    expect(loadConfig(join(tmpdir(), 'es-no-such-config-xyz.json'))).toEqual({});
  });

  test('loads JSON config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'es-cfg-'));
    const f = join(dir, 'cfg.json');
    writeFileSync(f, JSON.stringify({ key: 'pw', server: 'h:1', port: 1, outputDir: 'o' }));
    expect(loadConfig(f)).toEqual({ key: 'pw', server: 'h:1', port: 1, outputDir: 'o' });
  });

  test('broken JSON warns and yields empty config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'es-cfg-'));
    const f = join(dir, 'bad.json');
    writeFileSync(f, '{{{');
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(loadConfig(f)).toEqual({});
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test('default path lives in the home directory', () => {
    expect(DEFAULT_CONFIG_PATH.endsWith('.encrypted-share.json')).toBe(true);
  });
});
