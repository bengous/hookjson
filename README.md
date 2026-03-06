# hookjson

Universal AI-friendly git hook wrapper. Wraps any command and emits NDJSON when activated.

## Install

```bash
bun add -D hookjson
```

Requires [Bun](https://bun.sh) runtime.

## Usage

```
hookjson --tool <name> [--] <command...>
```

**Dual mode** controlled by `HOOKS_FORMAT` env var:

- **Not set (human mode):** transparent passthrough. Command runs normally, stdout/stderr flow to terminal, exit code preserved. Zero overhead.
- **Set to `"json"` (agent mode):** captures stdout/stderr/exit code, detects whether stdout is valid JSON, emits one NDJSON line.

### Examples

```bash
# Human mode — passthrough
hookjson --tool biome -- biome lint src/

# Agent mode — NDJSON output
HOOKS_FORMAT=json hookjson --tool biome -- biome lint --reporter=json src/
```

## Output Schema

Each invocation emits a single JSON line to stdout:

```typescript
interface HookJsonOutput {
    tool: string;        // from --tool flag
    success: boolean;    // exit_code === 0
    exit_code: number;   // wrapped command's exit code
    output: unknown;     // parsed JSON object if valid JSON, raw string otherwise
    stderr?: string;     // only present if non-empty
    error?: string;      // only on hookjson internal errors
}
```

### Output examples

Tool produces JSON (auto-nested):
```json
{"tool":"biome-lint","success":true,"exit_code":0,"output":{"diagnostics":[],"command":"lint"}}
```

Tool produces plain text (kept as string):
```json
{"tool":"bun-test","success":false,"exit_code":1,"output":"3 pass\n1 fail","stderr":"expected true, got false"}
```

## Integration

### With lefthook

```yaml
# .lefthook.yml
pre-commit:
  commands:
    lint:
      run: hookjson --tool biome-lint -- biome lint --reporter=json {staged_files}
    test:
      run: hookjson --tool bun-test -- bun test
```

### With husky

```bash
# .husky/pre-commit
hookjson --tool biome-lint -- biome lint --reporter=json src/
hookjson --tool bun-test -- bun test
```

### Activating JSON mode for AI agents

Set `HOOKS_FORMAT=json` in your agent's environment. For Claude Code:

```jsonc
// .claude/settings.json
{
    "env": {
        "HOOKS_FORMAT": "json"
    }
}
```

## How JSON detection works

When in JSON mode, hookjson captures stdout and attempts `JSON.parse()`. If the result is an object or array, it's nested directly in the `output` field. Otherwise (plain text, primitives, parse failure), the raw trimmed string is used. This means tools that support JSON reporters (biome, eslint, etc.) get their structured output preserved automatically.

## License

MIT
