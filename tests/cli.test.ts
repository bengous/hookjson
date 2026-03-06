import { describe, expect, test } from 'bun:test';
import { parseArgs } from '../src/cli.ts';

describe('parseArgs', () => {
    test('--tool name -- command', () => {
        const result = parseArgs(['--tool', 'biome', '--', 'biome', 'lint']);
        expect(result).toEqual({ tool: 'biome', command: ['biome', 'lint'] });
    });

    test('--tool name command (no separator)', () => {
        const result = parseArgs(['--tool', 'test', 'echo', 'hello']);
        expect(result).toEqual({ tool: 'test', command: ['echo', 'hello'] });
    });

    test('missing --tool', () => {
        const result = parseArgs(['echo', 'hello']);
        expect(result).toBeNull();
    });

    test('no command', () => {
        const result = parseArgs(['--tool', 'test']);
        expect(result).toBeNull();
    });

    test('--tool without value', () => {
        const result = parseArgs(['--tool']);
        expect(result).toBeNull();
    });

    test('--tool with -- but no command', () => {
        const result = parseArgs(['--tool', 'test', '--']);
        expect(result).toBeNull();
    });
});

describe('E2E', () => {
    const CLI = ['bun', 'src/cli.ts'];

    test('passthrough mode (no HOOKS_FORMAT)', async () => {
        const proc = Bun.spawn([...CLI, '--tool', 'test', '--', 'echo', 'passthrough'], {
            stdout: 'pipe',
            stderr: 'pipe',
        });
        const stdout = await new Response(proc.stdout).text();
        const exitCode = await proc.exited;
        expect(exitCode).toBe(0);
        expect(stdout.trim()).toBe('passthrough');
    });

    test('JSON mode emits valid NDJSON', async () => {
        const proc = Bun.spawn([...CLI, '--tool', 'mytest', '--', 'echo', 'hello'], {
            stdout: 'pipe',
            stderr: 'pipe',
            env: { ...process.env, HOOKS_FORMAT: 'json' },
        });
        const stdout = await new Response(proc.stdout).text();
        const exitCode = await proc.exited;
        expect(exitCode).toBe(0);
        const parsed = JSON.parse(stdout.trim());
        expect(parsed.tool).toBe('mytest');
        expect(parsed.success).toBe(true);
        expect(parsed.exit_code).toBe(0);
        expect(parsed.output).toBe('hello');
    });

    test('JSON mode with JSON-producing command nests output', async () => {
        const proc = Bun.spawn([...CLI, '--tool', 'biome', '--', 'sh', '-c', 'echo \'{"errors":0}\''], {
            stdout: 'pipe',
            stderr: 'pipe',
            env: { ...process.env, HOOKS_FORMAT: 'json' },
        });
        const stdout = await new Response(proc.stdout).text();
        const exitCode = await proc.exited;
        expect(exitCode).toBe(0);
        const parsed = JSON.parse(stdout.trim());
        expect(parsed.output).toEqual({ errors: 0 });
    });

    test('failing command sets success=false', async () => {
        const proc = Bun.spawn([...CLI, '--tool', 'test', '--', 'sh', '-c', 'exit 3'], {
            stdout: 'pipe',
            stderr: 'pipe',
            env: { ...process.env, HOOKS_FORMAT: 'json' },
        });
        const stdout = await new Response(proc.stdout).text();
        const exitCode = await proc.exited;
        expect(exitCode).toBe(3);
        const parsed = JSON.parse(stdout.trim());
        expect(parsed.success).toBe(false);
        expect(parsed.exit_code).toBe(3);
    });

    test('invalid args exits 2', async () => {
        const proc = Bun.spawn([...CLI], {
            stdout: 'pipe',
            stderr: 'pipe',
        });
        const stderr = await new Response(proc.stderr).text();
        const exitCode = await proc.exited;
        expect(exitCode).toBe(2);
        expect(stderr).toContain('Usage:');
    });
});
