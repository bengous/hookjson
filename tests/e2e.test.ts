import { beforeAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Effect } from 'effect';

const CLI_PATH = resolve(import.meta.dir, '../src/cli.ts');
const TEMP_PREFIX = 'hookjson-e2e-';

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────────────────────────────

class TempRepoError {
    readonly _tag = 'TempRepoError';
    constructor(readonly cause: unknown) {}
}

async function initRepo(dir: string): Promise<void> {
    const run = (...args: string[]) =>
        Bun.spawn(['git', '-C', dir, ...args], { stdout: 'pipe', stderr: 'pipe' }).exited;

    await run('init');
    await run('config', 'user.email', 'test@hookjson.dev');
    await run('config', 'user.name', 'hookjson-test');
    await Bun.write(join(dir, 'README.md'), 'seed\n');
    await run('add', 'README.md');
    await run('commit', '-m', 'seed');
}

const TempRepo = Effect.acquireRelease(
    Effect.tryPromise({
        try: async () => {
            const dir = await mkdtemp(join(tmpdir(), TEMP_PREFIX));
            await initRepo(dir);
            return dir;
        },
        catch: (cause) => new TempRepoError(cause),
    }),
    (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
);

function withRepo(fn: (repo: string) => Promise<void>): Promise<void> {
    return Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const repo = yield* TempRepo;
                yield* Effect.promise(() => fn(repo));
            }),
        ),
    );
}

async function installHook(repo: string, hookName: string, script: string): Promise<void> {
    const hookPath = join(repo, '.git', 'hooks', hookName);
    await Bun.write(hookPath, script);
    await chmod(hookPath, 0o755);
}

async function git(repo: string, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const proc = Bun.spawn(['git', '-C', repo, ...args], { stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const exitCode = await proc.exited;
    return { stdout, stderr, exitCode };
}

function extractAllNdjsonLines(output: string): Record<string, unknown>[] {
    const results: Record<string, unknown>[] = [];
    for (const line of output.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{')) continue;
        try {
            const parsed = JSON.parse(trimmed);
            if (typeof parsed === 'object' && parsed !== null && 'tool' in parsed) {
                results.push(parsed as Record<string, unknown>);
            }
        } catch {
            // not JSON, skip
        }
    }
    return results;
}

function extractNdjsonLine(output: string): Record<string, unknown> | null {
    return extractAllNdjsonLines(output)[0] ?? null;
}

function expectNdjson(result: { stdout: string; stderr: string }): Record<string, unknown> {
    const ndjson = extractNdjsonLine(result.stdout) ?? extractNdjsonLine(result.stderr);
    expect(ndjson).not.toBeNull();
    return ndjson as Record<string, unknown>;
}

function hookScript(command: string, jsonMode = false): string {
    const env = jsonMode ? 'HOOKS_FORMAT=json ' : '';
    return `#!/usr/bin/env bash\n${env}exec bun "${CLI_PATH}" --tool lint -- ${command}\n`;
}

function multiHookScript(commands: Array<{ tool: string; command: string }>, jsonMode: boolean): string {
    const lines = ['#!/usr/bin/env bash', 'set -euo pipefail'];
    for (const { tool, command } of commands) {
        if (jsonMode) {
            lines.push(`HOOKS_FORMAT=json bun "${CLI_PATH}" --tool ${tool} -- ${command}`);
        } else {
            lines.push(command);
        }
    }
    return `${lines.join('\n')}\n`;
}

// ── Stale cleanup ────────────────────────────────────────────────────────────────────────────────────────────────────

beforeAll(async () => {
    const tmp = tmpdir();
    const entries = await readdir(tmp);
    await Promise.all(
        entries.filter((e) => e.startsWith(TEMP_PREFIX)).map((e) => rm(join(tmp, e), { recursive: true, force: true })),
    );
});

// ── Tests ────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('e2e: hookjson as git hook', () => {
    describe('passthrough mode', () => {
        test('successful hook allows commit', () =>
            withRepo(async (repo) => {
                await installHook(repo, 'pre-commit', hookScript('echo "lint passed"'));
                await Bun.write(join(repo, 'file.txt'), 'clean\n');
                await git(repo, ['add', 'file.txt']);

                const result = await git(repo, ['commit', '-m', 'add file']);

                expect(result.exitCode).toBe(0);
                expect(extractNdjsonLine(result.stdout)).toBeNull();
                const log = await git(repo, ['log', '--oneline']);
                expect(log.stdout.trim().split('\n')).toHaveLength(2);
            }));

        test('failing hook blocks commit', () =>
            withRepo(async (repo) => {
                await installHook(repo, 'pre-commit', hookScript("sh -c 'exit 1'"));
                await Bun.write(join(repo, 'file.txt'), 'content\n');
                await git(repo, ['add', 'file.txt']);

                const result = await git(repo, ['commit', '-m', 'should fail']);

                expect(result.exitCode).not.toBe(0);
                const log = await git(repo, ['log', '--oneline']);
                expect(log.stdout.trim().split('\n')).toHaveLength(1);
            }));
    });

    describe('json mode', () => {
        test('successful hook emits NDJSON and allows commit', () =>
            withRepo(async (repo) => {
                await installHook(repo, 'pre-commit', hookScript('echo "all clean"', true));
                await Bun.write(join(repo, 'file.txt'), 'content\n');
                await git(repo, ['add', 'file.txt']);

                const result = await git(repo, ['commit', '-m', 'test']);

                expect(result.exitCode).toBe(0);
                const ndjson = expectNdjson(result);
                expect(ndjson.tool).toBe('lint');
                expect(ndjson.success).toBe(true);
                expect(ndjson.exit_code).toBe(0);
                expect(ndjson.output).toBe('all clean');
            }));

        test('failing hook emits NDJSON with stderr and blocks commit', () =>
            withRepo(async (repo) => {
                await installHook(repo, 'pre-commit', hookScript('sh -c \'echo "style error" >&2; exit 1\'', true));
                await Bun.write(join(repo, 'file.txt'), 'content\n');
                await git(repo, ['add', 'file.txt']);

                const result = await git(repo, ['commit', '-m', 'should fail']);

                expect(result.exitCode).not.toBe(0);
                const ndjson = expectNdjson(result);
                expect(ndjson.tool).toBe('lint');
                expect(ndjson.success).toBe(false);
                expect(ndjson.exit_code).toBe(1);
                expect(ndjson.stderr).toBe('style error');
            }));

        test('JSON-producing command nests output as parsed object', () =>
            withRepo(async (repo) => {
                const jsonCmd = `sh -c 'echo '"'"'{"lint":"ok","errors":0}'"'"`;
                await installHook(repo, 'pre-commit', hookScript(jsonCmd, true));
                await Bun.write(join(repo, 'file.txt'), 'content\n');
                await git(repo, ['add', 'file.txt']);

                const result = await git(repo, ['commit', '-m', 'test']);

                expect(result.exitCode).toBe(0);
                const ndjson = expectNdjson(result);
                expect(ndjson.output).toEqual({ lint: 'ok', errors: 0 });
            }));
    });

    describe('signal forwarding', () => {
        test(
            'SIGINT propagates to wrapped process',
            () =>
                withRepo(async (repo) => {
                    const sentinelPath = join(repo, '.signal-sentinel');
                    const script = [
                        '#!/usr/bin/env bash',
                        `HOOKS_FORMAT=json exec bun "${CLI_PATH}" --tool slow -- sh -c 'touch "${sentinelPath}"; sleep 60'`,
                    ].join('\n');
                    await installHook(repo, 'pre-commit', script);
                    await Bun.write(join(repo, 'file.txt'), 'content\n');
                    await git(repo, ['add', 'file.txt']);

                    const proc = Bun.spawn(['git', '-C', repo, 'commit', '-m', 'signal test'], {
                        stdout: 'pipe',
                        stderr: 'pipe',
                    });

                    // Poll for sentinel — deterministic readiness check
                    for (let i = 0; i < 60; i++) {
                        if (existsSync(sentinelPath)) break;
                        await Bun.sleep(50);
                    }
                    expect(existsSync(sentinelPath)).toBe(true);

                    proc.kill('SIGINT');
                    const exitCode = await proc.exited;
                    expect(exitCode).not.toBe(0);
                }),
            10_000,
        );
    });
});

// ── Multi-command hook tests (lefthook-style) ────────────────────────────────────────────────────────────────────────

const TOOLS_ALL_PASS: Array<{ tool: string; command: string }> = [
    { tool: 'lint', command: 'echo "Checked 12 files in 5ms. No fixes applied."' },
    { tool: 'test', command: `sh -c 'echo '"'"'{"suites":2,"tests":8,"pass":8,"fail":0}'"'"''` },
    { tool: 'guard', command: 'echo "No absolute paths found."' },
    { tool: 'links', command: 'echo "Links: 42 total, 0 broken"' },
];

const TOOLS_LINT_FAILS: Array<{ tool: string; command: string }> = [
    { tool: 'lint', command: `sh -c 'echo "error: unused import" >&2; exit 1'` },
    ...TOOLS_ALL_PASS.slice(1),
];

const TOOLS_TEST_FAILS: Array<{ tool: string; command: string }> = [
    TOOLS_ALL_PASS[0],
    {
        tool: 'test',
        command: `sh -c 'echo "test failed" >&2; echo '"'"'{"suites":2,"tests":8,"pass":7,"fail":1}'"'"'; exit 1'`,
    },
    ...TOOLS_ALL_PASS.slice(2),
];

describe('e2e: multi-command hook (lefthook-style)', () => {
    describe('RED: without hookjson', () => {
        test(
            'all passing — human-readable output, no structured data',
            () =>
                withRepo(async (repo) => {
                    await installHook(repo, 'pre-commit', multiHookScript(TOOLS_ALL_PASS, false));
                    await Bun.write(join(repo, 'file.txt'), 'content\n');
                    await git(repo, ['add', 'file.txt']);

                    const result = await git(repo, ['commit', '-m', 'multi-pass']);
                    const combined = `${result.stdout}\n${result.stderr}`;

                    expect(result.exitCode).toBe(0);
                    expect(combined).toContain('Checked 12 files');
                    expect(combined).toContain('Links: 42 total');
                    expect(extractAllNdjsonLines(combined)).toHaveLength(0);
                    const log = await git(repo, ['log', '--oneline']);
                    expect(log.stdout.trim().split('\n')).toHaveLength(2);
                }),
            15_000,
        );

        test(
            'one failing — fail-fast stops execution',
            () =>
                withRepo(async (repo) => {
                    await installHook(repo, 'pre-commit', multiHookScript(TOOLS_LINT_FAILS, false));
                    await Bun.write(join(repo, 'file.txt'), 'content\n');
                    await git(repo, ['add', 'file.txt']);

                    const result = await git(repo, ['commit', '-m', 'should fail']);
                    const combined = `${result.stdout}\n${result.stderr}`;

                    expect(result.exitCode).not.toBe(0);
                    expect(combined).toContain('error: unused import');
                    expect(combined).not.toContain('Links');
                    const log = await git(repo, ['log', '--oneline']);
                    expect(log.stdout.trim().split('\n')).toHaveLength(1);
                }),
            15_000,
        );
    });

    describe('GREEN: with hookjson', () => {
        test(
            'all passing — 4 NDJSON lines with correct tools and parsed JSON output',
            () =>
                withRepo(async (repo) => {
                    await installHook(repo, 'pre-commit', multiHookScript(TOOLS_ALL_PASS, true));
                    await Bun.write(join(repo, 'file.txt'), 'content\n');
                    await git(repo, ['add', 'file.txt']);

                    const result = await git(repo, ['commit', '-m', 'multi-json']);
                    const combined = `${result.stdout}\n${result.stderr}`;
                    const lines = extractAllNdjsonLines(combined);

                    expect(result.exitCode).toBe(0);
                    expect(lines).toHaveLength(4);
                    expect(lines.map((l) => l.tool)).toEqual(['lint', 'test', 'guard', 'links']);
                    for (const line of lines) {
                        expect(line.success).toBe(true);
                        expect(line.exit_code).toBe(0);
                    }
                    expect(lines[0].output).toBe('Checked 12 files in 5ms. No fixes applied.');
                    expect(lines[1].output).toEqual({ suites: 2, tests: 8, pass: 8, fail: 0 });
                }),
            15_000,
        );

        test(
            'mid-pipeline failure — partial NDJSON + fail-fast',
            () =>
                withRepo(async (repo) => {
                    await installHook(repo, 'pre-commit', multiHookScript(TOOLS_TEST_FAILS, true));
                    await Bun.write(join(repo, 'file.txt'), 'content\n');
                    await git(repo, ['add', 'file.txt']);

                    const result = await git(repo, ['commit', '-m', 'mid-fail']);
                    const combined = `${result.stdout}\n${result.stderr}`;
                    const lines = extractAllNdjsonLines(combined);

                    expect(result.exitCode).not.toBe(0);
                    expect(lines).toHaveLength(2);
                    expect(lines[0].tool).toBe('lint');
                    expect(lines[0].success).toBe(true);
                    expect(lines[1].tool).toBe('test');
                    expect(lines[1].success).toBe(false);
                    expect(lines[1].exit_code).toBe(1);
                    expect(lines[1].stderr).toBe('test failed');
                    expect(lines[1].output).toEqual({ suites: 2, tests: 8, pass: 7, fail: 1 });
                }),
            15_000,
        );
    });
});
