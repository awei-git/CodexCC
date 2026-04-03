#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";

import { Command } from "commander";

import { InteractiveStateSync } from "./interactive-state-sync.js";
import { validateAssistantOutput } from "./policy.js";
import { buildInitialPromptWithContext, buildTurnPrompt } from "./prompt-builder.js";
import { detectRepoContext } from "./repo.js";
import { SessionStore } from "./session-store.js";
import { applyParsedState, extractStateBlock, parseStateBlock, readStateSource } from "./state-sync.js";
import { parseSlashCommand, handleSlashCommand } from "./slash-router.js";
import { spawnCodexPty } from "./pty.js";

function registerBaseOptions(command: Command): Command {
  return command.option("-C, --cd <dir>", "working directory", process.cwd());
}

function renderBanner(statePath: string, state: { mode: string; goal: string; currentStep: string; lastSummary: string }): string {
  return [
    "codex-agent interactive session",
    `Mode: ${state.mode} | Goal: ${state.goal || "-"} | Step: ${state.currentStep || "-"}`,
    `Summary: ${state.lastSummary || "-"}`,
    "Local commands: /agent /plan /review /resume /status /last /context /artifacts /diff /turns /policy /ship /reset /help",
    `State file: ${statePath}`,
    "",
  ].join("\n");
}

async function runStart(dir: string): Promise<void> {
  const repo = detectRepoContext(dir);
  const store = new SessionStore(repo);
  const state = await store.ensure();
  await store.appendLedger("session.start", { repoRoot: repo.root, branch: repo.branch });
  await store.appendTranscript("system", "Started interactive codex-agent session.");

  const localContext = await store.buildResumeContext();
  const initialPrompt = buildInitialPromptWithContext(state, localContext);
  const bridge = await spawnCodexPty(["--search", "--sandbox", "workspace-write", "--ask-for-approval", "on-request", "-C", repo.root, initialPrompt], repo.root);
  const sync = new InteractiveStateSync(store);
  await sync.beginTurn("startup");

  process.stdout.write(renderBanner(store.getStatePath(), state));

  bridge.onData((chunk) => {
    process.stdout.write(chunk);
    sync.consume(chunk);
  });
  bridge.onExit((exitCode) => {
    void (async () => {
      await sync.flush();
      process.exitCode = exitCode;
      process.exit();
    })();
  });

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  rl.on("line", async (line) => {
    const command = parseSlashCommand(line);
    if (!command) {
      const current = await store.read();
      const next = await store.patch({ attemptCount: current.attemptCount + 1 });
      await store.appendLedger("user.turn", {
        mode: next.mode,
        text: line,
      });
      await store.appendTranscript("user", line);
      await sync.beginTurn(`user:${next.mode}`);
      bridge.write(`${buildTurnPrompt(next, line)}\n`);
      return;
    }

    try {
      const action = await handleSlashCommand(command, store, repo);
      if (action.localOutput) {
        process.stdout.write(`${action.localOutput}`);
      }
      if (action.promptInjection) {
        await sync.beginTurn(`slash:${command.name}`);
        bridge.write(`${action.promptInjection}\n`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`slash command failed: ${message}\n`);
    }
  });

  process.on("SIGINT", () => {
    void (async () => {
      rl.close();
      await sync.flush();
      bridge.kill();
    })();
  });
}

async function runStatus(dir: string): Promise<void> {
  const repo = detectRepoContext(dir);
  const store = new SessionStore(repo);
  const state = await store.ensure();
  process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
}

async function runSync(dir: string, filePath?: string): Promise<void> {
  const repo = detectRepoContext(dir);
  const store = new SessionStore(repo);
  const current = await store.ensure();
  const source = await readStateSource(filePath);
  const block = extractStateBlock(source);
  if (!block) {
    throw new Error("no state block found");
  }
  const parsed = parseStateBlock(block);
  const next = applyParsedState(current, parsed);
  const written = await store.write(next);
  await store.writeSummary(written);
  await store.writeAssistantSnapshot(source);
  await store.appendTranscript("assistant", source);
  const violations = validateAssistantOutput(written.mode, source);
  const artifactPath = await store.writeAssistantTurnArtifact("sync-import", written.mode, source, violations);
  if (violations.length > 0) {
    await store.appendPolicyEvent({
      kind: "assistant_output_validation",
      mode: written.mode,
      turn: "sync-import",
      violations,
      artifactPath,
    });
  }
  await store.appendLedger("state.sync", { filePath: filePath ?? "stdin" });
  process.stdout.write(`${store.getStatePath()}\n`);
}

async function runExec(dir: string, prompt: string): Promise<void> {
  const repo = detectRepoContext(dir);
  const store = new SessionStore(repo);
  const state = await store.ensure();
  const slash = parseSlashCommand(prompt);
  if (
    slash?.name === "status" ||
    slash?.name === "help" ||
    slash?.name === "reset" ||
    slash?.name === "last" ||
    slash?.name === "context" ||
    slash?.name === "artifacts" ||
    slash?.name === "diff" ||
    slash?.name === "turns" ||
    slash?.name === "policy"
  ) {
    const action = await handleSlashCommand(slash, store, repo);
    if (action.localOutput) {
      process.stdout.write(action.localOutput);
    }
    return;
  }

  let mergedPrompt = buildTurnPrompt(state, prompt);
  if (slash) {
    const action = await handleSlashCommand(slash, store, repo);
    if (action.localOutput) {
      process.stdout.write(action.localOutput);
    }
    mergedPrompt = action.promptInjection ?? mergedPrompt;
  } else {
    await store.appendTranscript("user", prompt);
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-agent-"));
  const outFile = path.join(tempDir, "last-message.txt");

  try {
    const child = spawn(
      "codex",
      [
        "exec",
        "--sandbox",
        "workspace-write",
        "-C",
        repo.root,
        "--skip-git-repo-check",
        "--output-last-message",
        outFile,
        mergedPrompt,
      ],
      {
        cwd: repo.root,
        stdio: "inherit",
      },
    );

    const exitCode = await new Promise<number>((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code) => resolve(code ?? 1));
    });

    if (exitCode !== 0) {
      throw new Error(`codex exec exited ${exitCode}`);
    }

    const text = await readFile(outFile, "utf8");
    const block = extractStateBlock(text);
    if (block) {
      const parsed = parseStateBlock(block);
      const next = applyParsedState(await store.read(), parsed);
      const written = await store.write(next);
      await store.writeSummary(written);
      await store.writeAssistantSnapshot(text);
      await store.appendTranscript("assistant", text);
      const violations = validateAssistantOutput(written.mode, text);
      const artifactPath = await store.writeAssistantTurnArtifact("exec", written.mode, text, violations);
      if (violations.length > 0) {
        await store.appendPolicyEvent({
          kind: "assistant_output_validation",
          mode: written.mode,
          turn: "exec",
          violations,
          artifactPath,
        });
      }
      await store.appendLedger("exec.sync", { prompt });
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

const program = new Command()
  .name("codex-agent")
  .description("A TypeScript general-agent harness on top of Codex.");

registerBaseOptions(program)
  .action(async (options: { cd: string }) => {
    await runStart(options.cd);
  });

registerBaseOptions(program.command("start"))
  .description("Start an interactive codex-agent session")
  .action(async (options: { cd: string }) => {
    await runStart(options.cd);
  });

registerBaseOptions(program.command("status"))
  .description("Print the repo-scoped session state")
  .action(async (options: { cd: string }) => {
    await runStatus(options.cd);
  });

registerBaseOptions(program.command("sync"))
  .description("Sync a trailing ```state block into the repo session state")
  .argument("[file]", "file containing the last model message; defaults to stdin")
  .action(async (file: string | undefined, options: { cd: string }) => {
    await runSync(options.cd, file);
  });

registerBaseOptions(program.command("exec"))
  .description("Run codex exec with the harness bootstrap and sync state afterward")
  .argument("<prompt>", "prompt to run through codex exec")
  .action(async (prompt: string, options: { cd: string }) => {
    await runExec(options.cd, prompt);
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
