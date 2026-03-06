#!/usr/bin/env bun

import { forwardSignal, runCapture, runPassthrough } from './run.ts';

interface ParsedArgs {
    tool: string;
    command: string[];
}

export function parseArgs(argv: string[]): ParsedArgs | null {
    let tool: string | null = null;
    let commandStart = -1;

    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--tool') {
            if (i + 1 >= argv.length) return null;
            tool = argv[i + 1];
            i++; // skip value
        } else if (argv[i] === '--') {
            commandStart = i + 1;
            break;
        } else if (tool !== null) {
            // First non-flag arg after --tool pair: start of command
            commandStart = i;
            break;
        }
    }

    if (!tool) return null;

    const command = commandStart >= 0 ? argv.slice(commandStart) : [];
    if (command.length === 0) return null;

    return { tool, command };
}

const USAGE = 'Usage: hookjson --tool <name> [--] <command...>';

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));

    if (!args) {
        process.stderr.write(`${USAGE}\n`);
        process.exit(2);
    }

    process.on('SIGINT', () => forwardSignal('SIGINT'));
    process.on('SIGTERM', () => forwardSignal('SIGTERM'));

    const jsonMode = process.env.HOOKS_FORMAT === 'json';

    if (jsonMode) {
        const { line, exitCode } = await runCapture(args.tool, args.command);
        process.stdout.write(`${line}\n`);
        process.exit(exitCode);
    } else {
        const exitCode = await runPassthrough(args.command);
        process.exit(exitCode);
    }
}

if (import.meta.main) {
    main().catch((err) => {
        const jsonMode = process.env.HOOKS_FORMAT === 'json';
        if (jsonMode) {
            const errorLine = JSON.stringify({
                tool: 'hookjson',
                success: false,
                exit_code: 1,
                output: '',
                error: err instanceof Error ? err.message : String(err),
            });
            process.stdout.write(`${errorLine}\n`);
        } else {
            process.stderr.write(`hookjson: ${err instanceof Error ? err.message : String(err)}\n`);
        }
        process.exit(1);
    });
}
