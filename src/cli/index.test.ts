import { describe, it, expect } from 'vitest';
import { parseArgs } from './parse-args.js';

describe('parseArgs', () => {
  // Helper: simulate process.argv with node + script path prefix
  function parse(...args: string[]) {
    return parseArgs(['node', 'cartographer', ...args]);
  }

  it('parses run command with file', () => {
    const result = parse('run', 'my-tree.ts');
    expect(result.command).toBe('run');
    expect(result.file).toBe('my-tree.ts');
    expect(result.positional).toEqual([]);
  });

  it('parses run command with positional args', () => {
    const result = parse('run', 'my-tree.ts', 'arg1', 'arg2');
    expect(result.command).toBe('run');
    expect(result.file).toBe('my-tree.ts');
    expect(result.positional).toEqual(['arg1', 'arg2']);
  });

  it('parses -- separator for positional args', () => {
    const result = parse('run', 'my-tree.ts', '--', '--flag', 'value');
    expect(result.positional).toEqual(['--flag', 'value']);
  });

  it('parses inspect command', () => {
    const result = parse('inspect', 'my-tree.ts');
    expect(result.command).toBe('inspect');
    expect(result.file).toBe('my-tree.ts');
  });

  it('parses init command', () => {
    const result = parse('init', 'my-tree');
    expect(result.command).toBe('init');
    expect(result.file).toBe('my-tree');
  });

  it('parses --json flag', () => {
    const result = parse('run', 'my-tree.ts', '--json');
    expect(result.flags.json).toBe(true);
  });

  it('parses --verbose flag', () => {
    const result = parse('run', 'my-tree.ts', '--verbose');
    expect(result.flags.verbose).toBe(true);
  });

  it('parses --quiet flag', () => {
    const result = parse('run', 'my-tree.ts', '--quiet');
    expect(result.flags.quiet).toBe(true);
  });

  it('parses --env-file with value', () => {
    const result = parse('run', 'my-tree.ts', '--env-file', '.env');
    expect(result.flags.envFile).toBe('.env');
  });

  it('parses --help flag', () => {
    const result = parse('--help');
    expect(result.flags.help).toBe(true);
  });

  it('parses -h flag', () => {
    const result = parse('-h');
    expect(result.flags.help).toBe(true);
  });

  it('handles empty args', () => {
    const result = parse();
    expect(result.command).toBe('');
    expect(result.file).toBe('');
  });

  it('flags before command are parsed correctly', () => {
    const result = parse('--json', 'run', 'my-tree.ts');
    expect(result.flags.json).toBe(true);
    expect(result.command).toBe('run');
    expect(result.file).toBe('my-tree.ts');
  });

  it('multiple flags together', () => {
    const result = parse('run', 'my-tree.ts', '--json', '--verbose', '--env-file', '.env.local');
    expect(result.flags.json).toBe(true);
    expect(result.flags.verbose).toBe(true);
    expect(result.flags.envFile).toBe('.env.local');
  });

  it('parses --no-dashboard flag', () => {
    const result = parseArgs(['node', 'cli', 'run', 'tree.ts', '--no-dashboard']);
    expect(result.flags.noDashboard).toBe(true);
  });

  it('noDashboard defaults to false', () => {
    const result = parseArgs(['node', 'cli', 'run', 'tree.ts']);
    expect(result.flags.noDashboard).toBe(false);
  });

  it('parses --dashboard-port flag', () => {
    const result = parseArgs(['node', 'cli', 'run', 'tree.ts', '--dashboard-port', '4000']);
    expect(result.flags.dashboardPort).toBe(4000);
  });
});
