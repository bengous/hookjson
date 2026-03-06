import { describe, expect, test } from 'bun:test';
import { runCapture, runPassthrough, tryParseJson } from '../src/run.ts';

describe('tryParseJson', () => {
    test('valid object', () => {
        const result = tryParseJson('{"a":1}');
        expect(result).toEqual({ a: 1 });
    });

    test('valid array', () => {
        const result = tryParseJson('[1,2,3]');
        expect(result).toEqual([1, 2, 3]);
    });

    test('invalid text', () => {
        const result = tryParseJson('hello world');
        expect(result).toBe('hello world');
    });

    test('empty string', () => {
        const result = tryParseJson('');
        expect(result).toBe('');
    });

    test('primitive number', () => {
        const result = tryParseJson('42');
        expect(result).toBe('42');
    });

    test('primitive boolean', () => {
        const result = tryParseJson('true');
        expect(result).toBe('true');
    });

    test('whitespace-wrapped JSON', () => {
        const result = tryParseJson('  \n{"key":"val"}\n  ');
        expect(result).toEqual({ key: 'val' });
    });
});

describe('runPassthrough', () => {
    test('echo exits 0', async () => {
        const code = await runPassthrough(['echo', 'hello']);
        expect(code).toBe(0);
    });

    test('exit 42', async () => {
        const code = await runPassthrough(['sh', '-c', 'exit 42']);
        expect(code).toBe(42);
    });

    test('nonexistent command returns 127', async () => {
        const code = await runPassthrough(['__hookjson_nonexistent_command__']);
        expect(code).toBe(127);
    });
});

describe('runCapture', () => {
    test('JSON stdout produces parsed output', async () => {
        const { line, exitCode } = await runCapture('test-tool', ['sh', '-c', 'echo \'{"ok":true}\'']);
        expect(exitCode).toBe(0);
        const parsed = JSON.parse(line);
        expect(parsed.tool).toBe('test-tool');
        expect(parsed.success).toBe(true);
        expect(parsed.exit_code).toBe(0);
        expect(parsed.output).toEqual({ ok: true });
        expect(parsed.stderr).toBeUndefined();
    });

    test('plain stdout produces string output', async () => {
        const { line, exitCode } = await runCapture('test-tool', ['echo', 'just text']);
        expect(exitCode).toBe(0);
        const parsed = JSON.parse(line);
        expect(parsed.output).toBe('just text');
    });

    test('stderr present', async () => {
        const { line, exitCode } = await runCapture('test-tool', ['sh', '-c', 'echo out; echo err >&2; exit 1']);
        expect(exitCode).toBe(1);
        const parsed = JSON.parse(line);
        expect(parsed.success).toBe(false);
        expect(parsed.exit_code).toBe(1);
        expect(parsed.output).toBe('out');
        expect(parsed.stderr).toBe('err');
    });

    test('empty stdout', async () => {
        const { line } = await runCapture('test-tool', ['sh', '-c', 'exit 0']);
        const parsed = JSON.parse(line);
        expect(parsed.output).toBe('');
    });

    test('command not found', async () => {
        const { line, exitCode } = await runCapture('test-tool', ['__hookjson_nonexistent_command__']);
        expect(exitCode).toBe(127);
        const parsed = JSON.parse(line);
        expect(parsed.success).toBe(false);
        expect(parsed.exit_code).toBe(127);
        expect(parsed.error).toContain('command not found');
    });
});
