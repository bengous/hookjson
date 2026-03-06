import type { Subprocess } from 'bun';
import type { HookJsonOutput } from './types.ts';

let activeProc: Subprocess | null = null;

export function forwardSignal(signal: NodeJS.Signals): void {
    if (activeProc) {
        activeProc.kill(signal === 'SIGTERM' ? 'SIGTERM' : 'SIGINT');
    }
}

export function tryParseJson(text: string): unknown {
    const trimmed = text.trim();
    if (trimmed === '') return '';
    try {
        const parsed = JSON.parse(trimmed);
        if (typeof parsed === 'object' && parsed !== null) {
            return parsed;
        }
        return text.trim();
    } catch {
        return text.trim();
    }
}

export async function runPassthrough(command: string[]): Promise<number> {
    try {
        const proc = Bun.spawn(command, {
            stdout: 'inherit',
            stderr: 'inherit',
            stdin: 'inherit',
        });
        activeProc = proc;
        const code = await proc.exited;
        activeProc = null;
        return code;
    } catch (err) {
        activeProc = null;
        if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
            return 127;
        }
        throw err;
    }
}

export async function runCapture(tool: string, command: string[]): Promise<{ line: string; exitCode: number }> {
    try {
        const proc = Bun.spawn(command, {
            stdout: 'pipe',
            stderr: 'pipe',
            stdin: 'inherit',
        });
        activeProc = proc;

        const [stdout, stderr] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
        ]);
        const exitCode = await proc.exited;
        activeProc = null;

        const result: HookJsonOutput = {
            tool,
            success: exitCode === 0,
            exit_code: exitCode,
            output: tryParseJson(stdout),
        };

        if (stderr.trim()) {
            result.stderr = stderr.trim();
        }

        return { line: JSON.stringify(result), exitCode };
    } catch (err) {
        activeProc = null;
        if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
            const result: HookJsonOutput = {
                tool,
                success: false,
                exit_code: 127,
                output: '',
                error: `command not found: ${command[0]}`,
            };
            return { line: JSON.stringify(result), exitCode: 127 };
        }
        throw err;
    }
}
