# E2E Test Suite for hookjson

## Context

hookjson has unit tests (`tests/run.test.ts`) and CLI-level tests (`tests/cli.test.ts`), but nothing exercises it as an actual git hook in a real repository. This plan adds `tests/e2e.test.ts` — a single file that creates temporary git repos, installs hookjson as a pre-commit hook, and verifies both passthrough and JSON modes end-to-end.

Uses **Effect** (`acquireRelease` + `Scope`) for guaranteed temp repo cleanup, even when tests fail or throw.

## Changes

### 1. Add `effect` devDependency

```bash
bun add -d effect
```

### 2. Create `tests/e2e.test.ts`

#### Resource: `TempRepo`

An Effect resource using `acquireRelease`:
- **Acquire**: `mkdtemp(join(tmpdir(), 'hookjson-e2e-'))` → `git init` → local `user.email`/`user.name` config → write `README.md` → `git add` → `git commit -m "seed"` → return repo path
- **Release**: `rm(repoPath, { recursive: true, force: true })` — always runs, even on test failure

#### Stale cleanup

`beforeAll` scans `tmpdir()` for directories matching `hookjson-e2e-*` and removes them. This handles leftovers from killed previous runs, ensuring multiple `bun test` invocations don't accumulate garbage.

#### Helpers

```
CLI_PATH = resolve(import.meta.dir, '../src/cli.ts')
```

| Helper | Signature | Responsibility |
|--------|-----------|---------------|
| `TempRepo` | `Effect<string, never, Scope>` | Effect resource — acquire creates temp git repo, release removes it |
| `installHook` | `(repo, hookName, script) → Promise<void>` | Writes script to `.git/hooks/<hookName>`, chmod 755 |
| `git` | `(repo, args) → Promise<{stdout, stderr, exitCode}>` | Spawns `git -C <repo>`, captures all output |
| `extractNdjsonLine` | `(output: string) → Record<string, unknown> \| null` | Finds first JSON line with a `tool` field in mixed git output |
| `withRepo` | `(fn: (repo: string) => Promise<void>) → Promise<void>` | Convenience wrapper: `Effect.runPromise(Effect.scoped(Effect.gen(...)))` |

`withRepo` keeps individual tests clean — they just receive a repo path and run assertions:

```ts
test('name', () => withRepo(async (repo) => {
    await installHook(repo, 'pre-commit', hookScript);
    // stage, commit, assert
}));
```

#### Test isolation

Each test gets its own temp repo via `TempRepo` resource. No shared state between tests. `mkdtemp` guarantees unique directory names, so parallel test file execution is safe.

#### Test cases

1. **Passthrough — success**: Hook wraps `echo "lint passed"`. Stage a file, commit. Assert exit 0, 2 commits in log, no NDJSON in output.

2. **Passthrough — failure**: Hook wraps `sh -c 'exit 1'`. Stage a file, commit. Assert exit non-zero, only seed commit remains.

3. **JSON mode — success**: Hook sets `HOOKS_FORMAT=json`, wraps `echo "all clean"`. Assert exit 0, NDJSON line has `tool: 'lint'`, `success: true`, `output: 'all clean'`.

4. **JSON mode — failure with stderr**: Hook wraps `sh -c 'echo "style error" >&2; exit 1'`. Assert exit non-zero, NDJSON has `success: false`, `exit_code: 1`, `stderr: 'style error'`.

5. **JSON mode — JSON-producing command**: Hook wraps a command that echoes `{"lint":"ok","errors":0}`. Assert `output` is a parsed object (not a string) — validates `tryParseJson` integration.

6. **Signal forwarding**: Hook wraps `sh -c 'touch sentinel; sleep 60'`. Spawn git commit without awaiting, poll for sentinel file (deterministic readiness check), send SIGINT, assert process exits promptly. 10s timeout as safety net.

### Key files

| File | Action |
|------|--------|
| `tests/e2e.test.ts` | **Create** — all E2E tests |
| `package.json` | **Modify** — add `effect` devDependency |
| `src/cli.ts` | Read-only — entry point the hooks invoke |
| `src/run.ts` | Read-only — `tryParseJson`, `runCapture`, `forwardSignal` |
| `src/types.ts` | Read-only — `HookJsonOutput` interface for assertion shapes |

### Style

- Biome-compliant: 4-space indent, single quotes, always semicolons, 120-char lines
- Matches existing patterns: `bun:test`, `Bun.spawn()`, `new Response(proc.stdout).text()`
- Hook scripts embed `HOOKS_FORMAT=json` directly for self-containment
- Effect usage limited to resource lifecycle — test logic stays as plain async/await

## Verification

```bash
bun test tests/e2e.test.ts   # Run only E2E tests
bun test                      # Run full suite (unit + E2E)
bun run lint                  # Verify Biome compliance
```
