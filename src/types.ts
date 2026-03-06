export interface HookJsonOutput {
    tool: string;
    success: boolean;
    exit_code: number;
    output: unknown;
    stderr?: string;
    error?: string;
}
