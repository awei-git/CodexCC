#!/usr/bin/env node
import process from "node:process";
import readline from "node:readline";

import { InteractiveStateSync } from "./interactive-state-sync.js";
import { buildInitialPromptWithContext, buildTurnPrompt } from "./prompt-builder.js";
import { detectRepoContext } from "./repo.js";
import { SessionStore } from "./session-store.js";
import { parseSlashCommand, handleSlashCommand } from "./slash-router.js";
import { spawnCodexPty } from "./pty.js";

type BridgeInput =
  | { type: "input"; text: string }
  | { type: "status" }
  | { type: "shutdown" }
  | { type: "ping" };

function parseArgs(argv: string[]): { cd: string } {
  let cd = process.cwd();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if ((arg === "-C" || arg === "--cd") && argv[i + 1]) {
      cd = argv[i + 1]!;
      i += 1;
    }
  }
  return { cd };
}

function send(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const repo = detectRepoContext(args.cd);
  const store = new SessionStore(repo);
  const state = await store.ensure();
  await store.appendLedger("bridge.start", { repoRoot: repo.root, branch: repo.branch });
  await store.appendTranscript("system", "Started CodexCC bridge session.");

  const localContext = await store.buildResumeContext();
  const initialPrompt = buildInitialPromptWithContext(state, localContext);
  const bridge = await spawnCodexPty(
    ["--search", "--sandbox", "workspace-write", "--ask-for-approval", "on-request", "-C", repo.root, initialPrompt],
    repo.root,
  );
  const sync = new InteractiveStateSync(store);
  await sync.beginTurn("bridge-startup");

  bridge.onData((chunk) => {
    sync.consume(chunk);
    send({ type: "output", data: chunk });
  });

  bridge.onExit((code) => {
    void (async () => {
      await sync.flush();
      send({ type: "exit", code });
      process.exitCode = code;
      process.exit();
    })();
  });

  send({
    type: "ready",
    repoRoot: repo.root,
    statePath: store.getStatePath(),
    summaryPath: store.getSummaryPath(),
    transcriptPath: store.getTranscriptPath(),
    turnsDir: store.getTurnsDir(),
    policyPath: store.getPolicyPath(),
  });

  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  rl.on("line", async (line) => {
    let msg: BridgeInput;
    try {
      msg = JSON.parse(line) as BridgeInput;
    } catch {
      send({ type: "error", message: "invalid json input" });
      return;
    }

    try {
      if (msg.type === "ping") {
        send({ type: "pong" });
        return;
      }

      if (msg.type === "status") {
        send({ type: "state", state: await store.read() });
        return;
      }

      if (msg.type === "shutdown") {
        rl.close();
        await sync.flush();
        bridge.kill();
        return;
      }

      if (msg.type === "input") {
        const text = msg.text;
        const slash = parseSlashCommand(text);

        if (!slash) {
          const current = await store.read();
          const next = await store.patch({ attemptCount: current.attemptCount + 1 });
          await store.appendLedger("bridge.user.turn", { mode: next.mode, text });
          await store.appendTranscript("user", text);
          await sync.beginTurn(`bridge-user:${next.mode}`);
          bridge.write(`${buildTurnPrompt(next, text)}\n`);
          return;
        }

        const action = await handleSlashCommand(slash, store, repo);
        if (action.localOutput) {
          send({ type: "output", data: action.localOutput });
        }
        if (action.promptInjection) {
          await sync.beginTurn(`bridge-slash:${slash.name}`);
          bridge.write(`${action.promptInjection}\n`);
        }
        return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      send({ type: "error", message });
    }
  });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  send({ type: "error", message });
  process.exit(1);
});
