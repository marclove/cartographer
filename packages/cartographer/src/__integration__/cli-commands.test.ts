import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const CLI = resolve(__dirname, '../cli/index.ts');
const FIXTURES = resolve(__dirname, 'fixtures/cli');
const PROJECT_ROOT = resolve(__dirname, '../../../..');

// Absolute path to tsx ESM loader — needed when spawning from a cwd
// outside the project tree (e.g. temp directories for init tests).
const TSX_ESM = resolve(PROJECT_ROOT, 'node_modules/tsx/dist/esm/index.mjs');

function runCli(
  args: string[],
  options?: { cwd?: string; timeout?: number },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const child = spawn('node', ['--import', TSX_ESM, CLI, ...args], {
      cwd: options?.cwd ?? PROJECT_ROOT,
      timeout: options?.timeout ?? 15_000,
      env: { ...process.env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.on('close', (code) => {
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
  });
}

function spawnCli(args: string[]): ChildProcess {
  return spawn('node', ['--import', TSX_ESM, CLI, ...args], {
    cwd: PROJECT_ROOT,
    env: { ...process.env },
  });
}

function waitForServer(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server not ready within 10s')), 10_000);
    child.stderr!.on('data', (chunk: Buffer) => {
      const match = chunk.toString().match(/localhost:(\d+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(parseInt(match[1], 10));
      }
    });
    child.on('close', () => {
      clearTimeout(timeout);
      reject(new Error('Process exited before server was ready'));
    });
  });
}

// ─── 1. No command / help ─────────────────────────────────────────────────────

describe('CLI: no command / help', () => {
  it('no args → exitCode 1, stdout contains "Usage:"', async () => {
    const result = await runCli([]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('Usage:');
  });

  it('--help → exitCode 0, stdout contains "Usage:"', async () => {
    const result = await runCli(['--help']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Usage:');
  });

  it('unknown command "bogus" → exitCode 1, stderr contains "Unknown command"', async () => {
    const result = await runCli(['bogus']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Unknown command');
  });
});

// ─── 2. init command ──────────────────────────────────────────────────────────

describe('CLI: init command', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir && existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('init my-tree → exitCode 0, stdout contains "Created", file exists', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cli-init-'));
    const result = await runCli(['init', 'my-tree'], { cwd: tmpDir });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Created');
    expect(existsSync(join(tmpDir, 'my-tree.ts'))).toBe(true);
  });

  it('init my-tree twice → second call exitCode 1, stderr contains "already exists"', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cli-init-'));
    await runCli(['init', 'my-tree'], { cwd: tmpDir });
    const result = await runCli(['init', 'my-tree'], { cwd: tmpDir });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('already exists');
  });

  it('init without name → exitCode 1, stderr contains "init requires a name"', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cli-init-'));
    const result = await runCli(['init'], { cwd: tmpDir });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('init requires a name');
  });

  it('created file contains the tree name in the template', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cli-init-'));
    await runCli(['init', 'my-tree'], { cwd: tmpDir });
    const content = readFileSync(join(tmpDir, 'my-tree.ts'), 'utf-8');
    expect(content).toContain("name: 'my-tree'");
  });
});

// ─── 3. inspect command ───────────────────────────────────────────────────────

describe('CLI: inspect command', () => {
  const inspectFixture = resolve(FIXTURES, 'inspect-tree.ts');

  it('inspect → exitCode 0, stdout contains [sequence], [action], [condition]', async () => {
    const result = await runCli(['inspect', inspectFixture]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('[sequence]');
    expect(result.stdout).toContain('[action]');
    expect(result.stdout).toContain('[condition]');
  });

  it('stdout contains "Nodes:" summary line', async () => {
    const result = await runCli(['inspect', inspectFixture]);
    expect(result.stdout).toMatch(/Nodes:\s+\d+/);
  });

  it('inspect without file → exitCode 1, stderr contains "inspect requires a file"', async () => {
    const result = await runCli(['inspect']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('inspect requires a file');
  });
});

// ─── 4. run command — batch mode ──────────────────────────────────────────────
//
// ActionNode returns RUNNING on the first tick (it starts the action
// asynchronously and reports the result on the *next* tick). Since the
// CLI's batch mode calls tree.run() which performs a single tick, all
// single-action trees exit with code 2 (RUNNING). This is the expected
// behavior — we verify the formatter output and correct exit codes.

describe('CLI: run command — batch mode', () => {
  it('run success-tree → exits with code 2 (RUNNING after single tick)', async () => {
    const result = await runCli(['run', resolve(FIXTURES, 'success-tree.ts')]);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain('success-test');
  });

  it('run failure-tree → exits with code 2 (RUNNING after single tick)', async () => {
    const result = await runCli(['run', resolve(FIXTURES, 'failure-tree.ts')]);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain('failure-test');
  });

  it('run --json success-tree → stdout lines parse as JSON', async () => {
    const result = await runCli(['run', '--json', resolve(FIXTURES, 'success-tree.ts')]);
    const lines = result.stdout.trim().split('\n').filter((l) => l.length > 0);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it('run --env-file env-tree → stdout contains "hello_from_env"', async () => {
    const result = await runCli([
      'run',
      '--env-file',
      resolve(FIXTURES, 'test.env'),
      resolve(FIXTURES, 'env-tree.ts'),
    ]);
    expect(result.stdout).toContain('hello_from_env');
  });

  it('run without file → exitCode 1, stderr contains "run requires a file"', async () => {
    const result = await runCli(['run']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('run requires a file');
  });
});

// ─── 5. run command — serve mode ──────────────────────────────────────────────

describe('CLI: run command — serve mode', () => {
  it(
    'serve with --no-tick --no-dashboard starts server, responds to /api/status, exits cleanly on SIGTERM',
    { timeout: 15_000 },
    async () => {
      const child = spawnCli([
        'run',
        '--serve',
        '--no-tick',
        '--no-dashboard',
        resolve(FIXTURES, 'serve-tree.ts'),
      ]);

      try {
        const port = await waitForServer(child);

        const resp = await fetch(`http://localhost:${port}/api/status`);
        expect(resp.status).toBe(200);

        child.kill('SIGTERM');

        const exitCode = await new Promise<number>((resolve) => {
          child.on('close', (code) => resolve(code ?? 1));
        });

        expect(exitCode).toBe(0);
      } finally {
        if (!child.killed) child.kill('SIGKILL');
      }
    },
  );

  it(
    'serve without --tick-interval or --no-tick exits with error',
    { timeout: 15_000 },
    async () => {
      const result = await runCli([
        'run',
        '--serve',
        resolve(FIXTURES, 'serve-tree.ts'),
      ]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('--tick-interval');
    },
  );
});
