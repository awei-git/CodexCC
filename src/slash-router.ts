import { buildModeInjection } from "./prompt-builder.js";
import { readRepoDiff } from "./repo.js";
import type { SessionStore } from "./session-store.js";
import type { RepoContext, SessionState, SlashAction, SlashCommand } from "./types.js";

export function parseSlashCommand(input: string): SlashCommand | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }

  const [name, ...rest] = trimmed.slice(1).split(/\s+/);
  if (!name) {
    return null;
  }

  if (!["agent", "plan", "review", "resume", "status", "ship", "help", "reset", "last", "context", "artifacts", "diff", "turns", "policy"].includes(name)) {
    return null;
  }

  return {
    name: name as SlashCommand["name"],
    arg: rest.join(" ").trim(),
    raw: trimmed,
  };
}

async function formatStatus(state: SessionState, store: SessionStore): Promise<string> {
  const [turnArtifacts, policyEvents] = await Promise.all([
    store.countTurnArtifacts(),
    store.countPolicyEvents(),
  ]);
  const lines = [
    `Repo: ${state.repoRoot}`,
    `Branch: ${state.branch}`,
    `Dirty: ${state.dirty ? "yes" : "no"}`,
    `Mode: ${state.mode}`,
    `Goal: ${state.goal || "-"}`,
    `Task type: ${state.taskType || "-"}`,
    `Current step: ${state.currentStep || "-"}`,
    `Working set: ${state.workingSet.length > 0 ? state.workingSet.join(", ") : "-"}`,
    `Attempts: ${state.attemptCount}`,
    `Risks: ${state.risks.length > 0 ? state.risks.join(", ") : "-"}`,
    `Last summary: ${state.lastSummary || "-"}`,
    `Turn artifacts: ${turnArtifacts}`,
    `Policy events: ${policyEvents}`,
    `Updated: ${state.updatedAt || "-"}`,
  ];
  return `${lines.join("\n")}\n`;
}

function formatHelp(): string {
  return [
    "Commands:",
    "/agent <goal>  switch to autonomous execution mode",
    "/plan <goal>   planning-only mode",
    "/review        reviewer mode, findings first",
    "/resume        recover from durable session state",
    "/ship          final verification and handoff mode",
    "/status        print local session state",
    "/last          print the last persisted assistant snapshot",
    "/context       print the local resume context bundle",
    "/artifacts     print local artifact file paths",
    "/diff          print the local git diff, if available",
    "/turns         print recent assistant turn artifact paths",
    "/policy        print recent policy validation events",
    "/reset         clear the durable session state for this repo",
    "/help          print this help",
    "",
  ].join("\n");
}

function formatArtifacts(store: SessionStore): string {
  return `${store.listArtifacts().join("\n")}\n`;
}

async function formatTurns(store: SessionStore): Promise<string> {
  const turns = await store.readRecentTurnArtifacts();
  return `${turns.length > 0 ? turns.join("\n") : "(no turn artifacts yet)"}\n`;
}

export async function handleSlashCommand(
  command: SlashCommand,
  store: SessionStore,
  repo?: RepoContext,
): Promise<SlashAction> {
  const state = await store.ensure();

  switch (command.name) {
    case "help":
      await store.appendLedger("slash.help", {});
      return { localOutput: formatHelp() };
    case "status":
      await store.appendLedger("slash.status", {});
      return { localOutput: await formatStatus(state, store) };
    case "last": {
      const snapshot = await store.readAssistantSnapshot();
      await store.appendLedger("slash.last", {});
      return { localOutput: `${snapshot || "(no assistant snapshot yet)"}\n` };
    }
    case "context": {
      const context = await store.buildResumeContext();
      await store.appendLedger("slash.context", {});
      return { localOutput: `${context}\n` };
    }
    case "artifacts":
      await store.appendLedger("slash.artifacts", {});
      return { localOutput: formatArtifacts(store) };
    case "diff": {
      const diff = repo ? readRepoDiff(repo.root) : "Repo context unavailable.";
      await store.appendLedger("slash.diff", {});
      return { localOutput: `${diff}\n` };
    }
    case "turns":
      await store.appendLedger("slash.turns", {});
      return { localOutput: await formatTurns(store) };
    case "policy": {
      const events = await store.readRecentPolicyEvents();
      await store.appendLedger("slash.policy", {});
      return { localOutput: `${events || "(no policy events yet)"}\n` };
    }
    case "reset": {
      const next = await store.reset();
      await store.appendLedger("slash.reset", {});
      await store.appendTranscript("system", "Session reset.");
      return {
        localOutput: `Session reset.\n${await formatStatus(next, store)}`,
      };
    }
    case "agent":
    case "plan":
    case "review":
    case "ship": {
      const next = await store.patch({
        mode: command.name,
        goal: command.arg || state.goal,
      });
      await store.writeSummary(next);
      await store.appendLedger(`slash.${command.name}`, { arg: command.arg });
      await store.appendTranscript("system", `Switched to ${command.name} mode.${command.arg ? ` Goal: ${command.arg}` : ""}`);
      return {
        localOutput: `Switched to ${command.name} mode.\n`,
        promptInjection: buildModeInjection(command.name, next, command.arg),
      };
    }
    case "resume": {
      const next = await store.patch({
        mode: "resume",
        goal: command.arg || state.goal,
      });
      await store.writeSummary(next);
      const summary = await store.readSummary();
      const resumeContext = await store.buildResumeContext();
      await store.appendLedger("slash.resume", { arg: command.arg });
      await store.appendTranscript("system", "Resuming from durable session state.");
      return {
        localOutput: `Resuming from durable session state.\n\n${summary}\n`,
        promptInjection: buildModeInjection("resume", next, command.arg, resumeContext),
      };
    }
  }
}
