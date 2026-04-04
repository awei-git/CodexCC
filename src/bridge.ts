#!/usr/bin/env node
import process from "node:process";
import readline from "node:readline";

import { buildTurnPrompt } from "./prompt-builder.js";
import { detectRepoContext } from "./repo.js";
import { ExecJsonRunner } from "./runner.js";
import { SessionStore } from "./session-store.js";
import { applyParsedState, extractStateBlock, parseStateBlock } from "./state-sync.js";
import { parseSlashCommand, handleSlashCommand } from "./slash-router.js";
import { validateAssistantOutput } from "./policy.js";
import type { RunnerTurnOptions } from "./runner.js";

type BridgeInput =
  | { type: "input"; text: string; options?: RunnerTurnOptions }
  | { type: "status" }
  | { type: "shutdown" }
  | { type: "ping" };

type BridgeHealth = "ready" | "running" | "failed" | "reconnecting";

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

async function persistAssistantTurn(
  store: SessionStore,
  label: string,
  text: string,
): Promise<{ statePath: string; artifactPath: string | null; violations: string[] }> {
  const trimmed = text.trim();
  let written = await store.read();

  const block = extractStateBlock(trimmed);
  if (block) {
    const parsed = parseStateBlock(block);
    written = await store.write(applyParsedState(written, parsed));
  }
  await store.writeSummary(written);

  if (!trimmed) {
    return {
      statePath: store.getStatePath(),
      artifactPath: null,
      violations: [],
    };
  }

  const snapshot = trimmed.slice(-12_000);
  await store.writeAssistantSnapshot(snapshot);
  await store.appendTranscript("assistant", snapshot);
  const violations = validateAssistantOutput(written.mode, snapshot);
  const artifactPath = await store.writeAssistantTurnArtifact(label, written.mode, snapshot, violations);

  if (violations.length > 0) {
    await store.appendPolicyEvent({
      kind: "assistant_output_validation",
      mode: written.mode,
      turn: label,
      violations,
      artifactPath,
    });
  }

  return {
    statePath: store.getStatePath(),
    artifactPath,
    violations,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const repo = detectRepoContext(args.cd);
  const store = new SessionStore(repo);
  await store.ensure();
  await store.appendLedger("bridge.start", { repoRoot: repo.root, branch: repo.branch });
  await store.appendTranscript("system", "Started CodexCC bridge session.");
  const runner = new ExecJsonRunner(repo.root);
  let health: BridgeHealth = "ready";
  let turnActive = false;

  const executeTurn = async (
    label: string,
    mode: string,
    prompt: string,
    options?: RunnerTurnOptions,
  ): Promise<void> => {
    turnActive = true;
    health = "running";
    send({ type: "turn_start", label, mode, health });

    try {
      const result = await runner.runTurn(
        prompt,
        options,
        {
          onOutput(data) {
            send({ type: "output", data });
          },
          onWarning(message) {
            send({ type: "warning", message });
          },
        },
      );

      const assistantText = result.lastMessage.trim() || result.streamedOutput.trim() || result.warnings.join("\n").trim();
      const persisted = await persistAssistantTurn(store, label, assistantText);
      await store.appendLedger("bridge.turn.completed", {
        label,
        exitCode: result.exitCode,
        warnings: result.warnings.length,
        artifactPath: persisted.artifactPath,
      });
      const nextState = await store.read();
      health = "ready";
      turnActive = false;
      send({ type: "state", state: nextState, health });
      if (result.exitCode !== 0) {
        send({
          type: "error",
          message: `CodexCC turn failed with exit code ${result.exitCode}.`,
        });
      }
      send({
        type: "turn_end",
        label,
        success: result.exitCode === 0,
        exitCode: result.exitCode,
        health,
        artifactPath: persisted.artifactPath,
        violations: persisted.violations,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      health = "failed";
      turnActive = false;
      await store.appendLedger("bridge.turn.failed", {
        label,
        message,
      });
      send({ type: "warning", message });
      send({ type: "error", message });
      send({
        type: "turn_end",
        label,
        success: false,
        exitCode: 1,
        health,
        artifactPath: null,
        violations: [],
      });
    }
  };

  send({
    type: "ready",
    repoRoot: repo.root,
    statePath: store.getStatePath(),
    summaryPath: store.getSummaryPath(),
    transcriptPath: store.getTranscriptPath(),
    turnsDir: store.getTurnsDir(),
    policyPath: store.getPolicyPath(),
    sessionDir: store.getSessionDir(),
    health,
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
        send({ type: "state", state: await store.read(), health });
        return;
      }

      if (msg.type === "shutdown") {
        rl.close();
        runner.kill();
        send({ type: "exit", code: 0 });
        process.exit(0);
        return;
      }

      if (msg.type === "input") {
        const text = msg.text;
        const turnOptions = msg.options;
        const slash = parseSlashCommand(text);

        if (!slash) {
          if (turnActive) {
            send({ type: "warning", message: "A CodexCC turn is already running. Wait for it to finish before sending another prompt." });
            return;
          }
          const current = await store.read();
          const next = await store.patch({ attemptCount: current.attemptCount + 1 });
          await store.appendLedger("bridge.user.turn", { mode: next.mode, text });
          await store.appendTranscript("user", text);
          const label = `bridge-user:${next.mode}`;
          await executeTurn(label, next.mode, buildTurnPrompt(next, text), turnOptions);
          return;
        }

        const action = await handleSlashCommand(slash, store, repo);
        if (action.localOutput) {
          send({ type: "output", data: action.localOutput });
        }
        if (action.promptInjection) {
          if (turnActive) {
            send({ type: "warning", message: "A CodexCC turn is already running. Wait for it to finish before sending another prompt." });
            return;
          }
          const current = await store.read();
          const next = await store.patch({ attemptCount: current.attemptCount + 1 });
          const label = `bridge-slash:${slash.name}`;
          await executeTurn(label, next.mode, action.promptInjection, turnOptions);
        }
        return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      health = "failed";
      turnActive = false;
      send({ type: "warning", message });
      send({ type: "error", message });
    }
  });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  send({ type: "error", message });
  process.exit(1);
});
