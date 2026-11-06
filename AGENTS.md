# hookjson

Universal AI-friendly git hook wrapper. Wraps any command and emits NDJSON when `HOOKS_FORMAT=json` is set.

## Commands

```bash
bun test              # Run all tests
bun run lint          # Biome check
bun run format        # Biome format
```

## Architecture

```
src/
  types.ts            # HookJsonOutput interface
  run.ts              # Core: spawn, capture, JSON detection, NDJSON formatting
  cli.ts              # Entry point: arg parsing, mode dispatch, signal forwarding
tests/
  run.test.ts         # Core logic tests with real subprocesses
  cli.test.ts         # Arg parsing + E2E tests
```

## Stack

- Bun runtime, TypeScript (strict), Biome
- Zero runtime dependencies
- `bin` points to `.ts` file — Bun runs TS natively, no build step

## Key Design

- Dual mode: `HOOKS_FORMAT=json` activates JSON capture, otherwise transparent passthrough
- `tryParseJson` auto-detects JSON stdout and nests it as an object in output
- CLI uses manual argv parsing (one flag + command, no dep needed)
