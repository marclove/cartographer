import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnvFile } from './shared.js';

let tmpFiles: string[] = [];

function writeTmp(name: string, content: string): string {
  const p = join('/tmp', `test-env-${name}-${Date.now()}`);
  writeFileSync(p, content, 'utf-8');
  tmpFiles.push(p);
  return p;
}

afterEach(() => {
  for (const f of tmpFiles) {
    try { unlinkSync(f); } catch { /* already removed */ }
  }
  tmpFiles = [];
});

describe('loadEnvFile', () => {
  it('parses simple KEY=VALUE pairs', () => {
    const file = writeTmp('simple', 'FOO=bar\nBAZ=qux\n');
    const target: Record<string, string | undefined> = {};
    loadEnvFile(file, target);
    expect(target).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('skips blank lines and comments', () => {
    const file = writeTmp('blanks', '\n# this is a comment\nKEY=val\n\n# another\n');
    const target: Record<string, string | undefined> = {};
    loadEnvFile(file, target);
    expect(target).toEqual({ KEY: 'val' });
  });

  it('skips lines without = sign', () => {
    const file = writeTmp('noeq', 'GOOD=value\nBADLINE\nALSO_GOOD=123\n');
    const target: Record<string, string | undefined> = {};
    loadEnvFile(file, target);
    expect(target).toEqual({ GOOD: 'value', ALSO_GOOD: '123' });
  });

  it('strips double-quoted values', () => {
    const file = writeTmp('dquote', 'KEY="hello world"\n');
    const target: Record<string, string | undefined> = {};
    loadEnvFile(file, target);
    expect(target).toEqual({ KEY: 'hello world' });
  });

  it('strips single-quoted values', () => {
    const file = writeTmp('squote', "KEY='hello world'\n");
    const target: Record<string, string | undefined> = {};
    loadEnvFile(file, target);
    expect(target).toEqual({ KEY: 'hello world' });
  });

  it('handles whitespace around keys and values', () => {
    const file = writeTmp('ws', '  FOO  =  bar  \n  BAZ = qux\n');
    const target: Record<string, string | undefined> = {};
    loadEnvFile(file, target);
    expect(target).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('overwrites existing keys in target', () => {
    const file = writeTmp('overwrite', 'KEY=new\n');
    const target: Record<string, string | undefined> = { KEY: 'old' };
    loadEnvFile(file, target);
    expect(target.KEY).toBe('new');
  });
});
