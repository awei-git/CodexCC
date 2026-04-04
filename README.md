# CodexCC

`CodexCC` is a Codex-based general-agent harness intended to mimic the working structure of Claude Code more closely than the raw Codex CLI.

It provides:

- repo-scoped durable session state
- slash-command routing
- mode-aware runtime policy
- transcript, summary, assistant snapshot, turn artifact, and policy event persistence
- an interactive CLI
- a JSONL stdio bridge for external hosts such as a VS Code extension
- a non-TTY `codex exec --json` runner for GUI-hosted turns

## Commands

```bash
pnpm install
pnpm build
node dist/cli.js
node dist/bridge.js --cd /path/to/repo
```

## Main Files

- `src/cli.ts`: terminal-first interactive harness
- `src/bridge.ts`: JSONL bridge for editors and external runtimes
- `src/runner.ts`: non-TTY `codex exec --json` runner used by GUI hosts
- `src/session-store.ts`: durable state and artifact persistence
- `src/policy.ts`: mode policy plus local validation
- `src/interactive-state-sync.ts`: assistant turn segmentation and state sync

## Bridge Protocol

The bridge communicates over JSON lines.

Input messages:

```json
{"type":"input","text":"fix the failing tests"}
{"type":"input","text":"/status"}
{"type":"status"}
{"type":"shutdown"}
```

Output messages:

```json
{"type":"ready","repoRoot":"...","statePath":"..."}
{"type":"output","data":"..."}
{"type":"state","state":{...}}
{"type":"turn_start","label":"...","mode":"agent","health":"running"}
{"type":"turn_end","label":"...","success":false,"exitCode":101}
{"type":"warning","message":"..."}
{"type":"exit","code":0}
{"type":"error","message":"..."}
```

## Environment overrides

The bridge and session store respect:

- `CODEX_AGENT_HOME`
- `CODEX_AGENT_TMPDIR`
- `CODEX_AGENT_SESSION_SUFFIX`
