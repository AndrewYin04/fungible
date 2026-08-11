import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const { TEST_DATA_DIR } = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const dir = path.join(os.tmpdir(), `fungible-env-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  return { TEST_DATA_DIR: dir };
});

vi.mock('../core/paths.js', () => ({ DATA_DIR: TEST_DATA_DIR }));

import { loadEnvFile, readEnvFile, secureEnvFile, writeEnvFile } from '../core/env-file.js';

const ENV_PATH = path.join(TEST_DATA_DIR, '.env');

beforeEach(() => {
  if (fs.existsSync(ENV_PATH)) fs.rmSync(ENV_PATH);
});

afterAll(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

describe('writeEnvFile', () => {
  it('creates the file when missing and writes the provided values', () => {
    const { written } = writeEnvFile({ PLAID_CLIENT_ID: 'abc', PLAID_SECRET: 'shh' });
    expect(written.sort()).toEqual(['PLAID_CLIENT_ID', 'PLAID_SECRET']);
    expect(fs.readFileSync(ENV_PATH, 'utf8')).toBe('PLAID_CLIENT_ID=abc\nPLAID_SECRET=shh\n');
  });

  it('replaces existing keys in place and preserves untouched keys, comments, and blank lines', () => {
    fs.writeFileSync(
      ENV_PATH,
      '# bank\nPLAID_CLIENT_ID=old\nPLAID_SECRET=oldsecret\n\n# other\nFUNGIBLE_BACKUP_DAYS=14\n',
    );
    writeEnvFile({ PLAID_CLIENT_ID: 'new' });
    expect(fs.readFileSync(ENV_PATH, 'utf8')).toBe(
      '# bank\nPLAID_CLIENT_ID=new\nPLAID_SECRET=oldsecret\n\n# other\nFUNGIBLE_BACKUP_DAYS=14\n',
    );
  });

  it('appends keys that did not previously exist', () => {
    fs.writeFileSync(ENV_PATH, 'PLAID_CLIENT_ID=abc\n');
    writeEnvFile({ ANTHROPIC_API_KEY: 'sk-ant-test' });
    expect(fs.readFileSync(ENV_PATH, 'utf8')).toBe('PLAID_CLIENT_ID=abc\nANTHROPIC_API_KEY=sk-ant-test\n');
  });

  /**
   * An empty value used to mean "ignore this key", so a credential could be
   * written but never removed: the Setup wizard blanked PLAID_SECRET, said
   * nothing, and left the old secret on disk. The two intentions are different
   * and the caller can state both — a key it passes empty is one it wants gone,
   * a key it does not pass is one it is not touching.
   */
  it('removes a key it is given with an empty or whitespace value', () => {
    fs.writeFileSync(
      ENV_PATH,
      '# bank\nPLAID_CLIENT_ID=cid\nPLAID_SECRET=shh\nANTHROPIC_API_KEY=sk-ant\n\nFUNGIBLE_BACKUP_DAYS=14\n',
    );
    const { written, cleared } = writeEnvFile({ PLAID_SECRET: '   ', ANTHROPIC_API_KEY: '' });

    expect(written).toEqual([]);
    expect(cleared.sort()).toEqual(['ANTHROPIC_API_KEY', 'PLAID_SECRET']);
    expect(fs.readFileSync(ENV_PATH, 'utf8')).toBe(
      '# bank\nPLAID_CLIENT_ID=cid\n\nFUNGIBLE_BACKUP_DAYS=14\n',
    );
    expect(readEnvFile().PLAID_SECRET).toBeUndefined();
  });

  it('leaves a key it was not given alone', () => {
    fs.writeFileSync(ENV_PATH, 'PLAID_CLIENT_ID=keepme\nPLAID_SECRET=shh\n');
    const { written, cleared } = writeEnvFile({ PLAID_SECRET: 'new' });
    expect(written).toEqual(['PLAID_SECRET']);
    expect(cleared).toEqual([]);
    expect(fs.readFileSync(ENV_PATH, 'utf8')).toBe('PLAID_CLIENT_ID=keepme\nPLAID_SECRET=new\n');
  });

  it('removes every assignment of a repeated key, not just the last', () => {
    fs.writeFileSync(ENV_PATH, 'PLAID_ENV=sandbox\nPLAID_ENV=production\nPLAID_SECRET=shh\n');
    const { cleared } = writeEnvFile({ PLAID_ENV: '' });
    expect(cleared).toEqual(['PLAID_ENV']);
    expect(fs.readFileSync(ENV_PATH, 'utf8')).toBe('PLAID_SECRET=shh\n');
  });

  it('does not create a file just to record that a cleared key is absent', () => {
    const { written, cleared } = writeEnvFile({ PLAID_SECRET: '' });
    expect(written).toEqual([]);
    expect(cleared).toEqual([]);
    expect(fs.existsSync(ENV_PATH)).toBe(false);
  });

  it('reports nothing cleared for a key that was not in the file', () => {
    fs.writeFileSync(ENV_PATH, 'PLAID_CLIENT_ID=cid\n');
    expect(writeEnvFile({ OPENAI_API_KEY: '' }).cleared).toEqual([]);
    expect(fs.readFileSync(ENV_PATH, 'utf8')).toBe('PLAID_CLIENT_ID=cid\n');
  });

  it('trims provided values before writing', () => {
    writeEnvFile({ OPENAI_API_KEY: '  sk-foo  ' });
    expect(fs.readFileSync(ENV_PATH, 'utf8')).toBe('OPENAI_API_KEY=sk-foo\n');
  });

  it('writes the file with 0600 perms', () => {
    writeEnvFile({ PLAID_SECRET: 'shh' });
    const mode = fs.statSync(ENV_PATH).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('tightens perms to 0600 on a pre-existing world-readable file', () => {
    fs.writeFileSync(ENV_PATH, 'PLAID_CLIENT_ID=old\n', { mode: 0o644 });
    writeEnvFile({ PLAID_CLIENT_ID: 'new' });
    const mode = fs.statSync(ENV_PATH).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('rejects values containing newlines (env injection)', () => {
    expect(() => writeEnvFile({ PLAID_SECRET: 'sk-live-abc\nANTHROPIC_API_KEY=BAD' })).toThrow(/line breaks/);
    expect(() => writeEnvFile({ PLAID_SECRET: 'sk-live-abc\rX=Y' })).toThrow(/line breaks/);
    expect(fs.existsSync(ENV_PATH)).toBe(false);
  });

  it('rejects invalid key names', () => {
    expect(() => writeEnvFile({ 'bad key': 'x' })).toThrow(/Invalid env key/);
    expect(() => writeEnvFile({ 'X=Y\nZ': 'x' })).toThrow(/Invalid env key/);
  });
});

describe('readEnvFile', () => {
  it('returns {} when the file does not exist', () => {
    expect(readEnvFile()).toEqual({});
  });

  it('parses keys, ignoring comments and blank lines, honouring export/quotes', () => {
    fs.writeFileSync(
      ENV_PATH,
      '# bank\nPLAID_CLIENT_ID=abc\n\nexport PLAID_SECRET="shh"\n  FUNGIBLE_BACKUP_DAYS = 14 \nnot a key\n',
    );
    expect(readEnvFile()).toEqual({
      PLAID_CLIENT_ID: 'abc',
      PLAID_SECRET: 'shh',
      FUNGIBLE_BACKUP_DAYS: '14',
    });
  });

  it('takes the last assignment of a repeated key, like dotenv', () => {
    fs.writeFileSync(ENV_PATH, 'PLAID_ENV=sandbox\nPLAID_ENV=production\n');
    expect(readEnvFile().PLAID_ENV).toBe('production');
  });

  it('round-trips what writeEnvFile wrote', () => {
    writeEnvFile({ PLAID_CLIENT_ID: 'abc', PLAID_SECRET: 'shh', PLAID_ENV: 'sandbox' });
    expect(readEnvFile()).toEqual({ PLAID_CLIENT_ID: 'abc', PLAID_SECRET: 'shh', PLAID_ENV: 'sandbox' });
  });
});

describe('secureEnvFile', () => {
  it('is a no-op when there is no env file', () => {
    expect(secureEnvFile()).toEqual({ changed: false });
    expect(fs.existsSync(ENV_PATH)).toBe(false);
  });

  it('tightens a group/world-readable file to 0600', () => {
    fs.writeFileSync(ENV_PATH, 'PLAID_SECRET=shh\n');
    fs.chmodSync(ENV_PATH, 0o664);
    expect(secureEnvFile()).toEqual({ changed: true, previousMode: 0o664 });
    expect(fs.statSync(ENV_PATH).mode & 0o777).toBe(0o600);
    // contents untouched
    expect(fs.readFileSync(ENV_PATH, 'utf8')).toBe('PLAID_SECRET=shh\n');
  });

  it('leaves an already-0600 file alone', () => {
    fs.writeFileSync(ENV_PATH, 'PLAID_SECRET=shh\n');
    fs.chmodSync(ENV_PATH, 0o600);
    expect(secureEnvFile()).toEqual({ changed: false });
    expect(fs.statSync(ENV_PATH).mode & 0o777).toBe(0o600);
  });
});

describe('loadEnvFile', () => {
  it('tightens the file and loads its values into process.env', () => {
    fs.writeFileSync(ENV_PATH, 'FUNGIBLE_TEST_LOAD=loaded\n');
    fs.chmodSync(ENV_PATH, 0o644);
    delete process.env.FUNGIBLE_TEST_LOAD;

    loadEnvFile({ quiet: true });

    expect(process.env.FUNGIBLE_TEST_LOAD).toBe('loaded');
    expect(fs.statSync(ENV_PATH).mode & 0o777).toBe(0o600);
    delete process.env.FUNGIBLE_TEST_LOAD;
  });
});
