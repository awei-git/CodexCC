import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { z } from "zod";

import type { HarnessMode, LedgerEvent, RepoContext, SessionState } from "./types.js";

const SessionSchema = z.object({
  repoRoot: z.string(),
  repoHash: z.string(),
  branch: z.string(),
  dirty: z.boolean(),
  mode: z.enum(["agent", "plan", "review", "resume", "ship"]),
  goal: z.string(),
  taskType: z.string(),
  workingSet: z.array(z.string()),
  plan: z.array(z.string()),
  currentStep: z.string(),
  attemptCount: z.number().int().nonnegative(),
  openQuestions: z.array(z.string()),
  risks: z.array(z.string()),
  lastSummary: z.string(),
  updatedAt: z.string(),
});

function nowIso(): string {
  return new Date().toISOString();
}

export class SessionStore {
  private readonly rootDir: string;
  private readonly sessionDir: string;
  private readonly statePath: string;
  private readonly ledgerPath: string;
  private readonly summaryPath: string;
  private readonly transcriptPath: string;
  private readonly assistantSnapshotPath: string;
  private readonly turnsDir: string;
  private readonly policyPath: string;

  public constructor(private readonly repo: RepoContext) {
    const agentHome = process.env.CODEX_AGENT_HOME?.trim() || path.join(os.homedir(), ".codex-agent");
    this.rootDir = path.join(agentHome, "sessions");
    this.sessionDir = path.join(this.rootDir, repo.hash);
    this.statePath = path.join(this.sessionDir, "current.json");
    this.ledgerPath = path.join(this.sessionDir, "ledger.jsonl");
    this.summaryPath = path.join(this.sessionDir, "summary.md");
    this.transcriptPath = path.join(this.sessionDir, "transcript.md");
    this.assistantSnapshotPath = path.join(this.sessionDir, "last-assistant.md");
    this.turnsDir = path.join(this.sessionDir, "turns");
    this.policyPath = path.join(this.sessionDir, "policy.jsonl");
  }

  public getStatePath(): string {
    return this.statePath;
  }

  public getSummaryPath(): string {
    return this.summaryPath;
  }

  public getTranscriptPath(): string {
    return this.transcriptPath;
  }

  public getAssistantSnapshotPath(): string {
    return this.assistantSnapshotPath;
  }

  public getTurnsDir(): string {
    return this.turnsDir;
  }

  public getPolicyPath(): string {
    return this.policyPath;
  }

  public async readSummary(): Promise<string> {
    try {
      return await readFile(this.summaryPath, "utf8");
    } catch {
      const state = await this.ensure();
      await this.writeSummary(state);
      return readFile(this.summaryPath, "utf8");
    }
  }

  public async appendTranscript(role: "user" | "assistant" | "system", text: string): Promise<void> {
    const entry = [
      `## ${role.toUpperCase()} ${nowIso()}`,
      "",
      text.trim() || "(empty)",
      "",
    ].join("\n");
    await mkdir(this.sessionDir, { recursive: true });
    await writeFile(this.transcriptPath, `${entry}\n`, {
      encoding: "utf8",
      flag: "a",
    });
  }

  public async readRecentTranscript(maxChars = 4000): Promise<string> {
    try {
      const text = await readFile(this.transcriptPath, "utf8");
      return text.slice(-maxChars);
    } catch {
      return "";
    }
  }

  public async writeAssistantSnapshot(text: string): Promise<void> {
    await mkdir(this.sessionDir, { recursive: true });
    await writeFile(this.assistantSnapshotPath, text, "utf8");
  }

  public async readAssistantSnapshot(): Promise<string> {
    try {
      return await readFile(this.assistantSnapshotPath, "utf8");
    } catch {
      return "";
    }
  }

  public async readRecentLedger(limit = 12): Promise<string> {
    try {
      const raw = await readFile(this.ledgerPath, "utf8");
      const lines = raw.trim().split("\n").filter(Boolean);
      return lines.slice(-limit).join("\n");
    } catch {
      return "";
    }
  }

  public async readRecentTurnArtifacts(limit = 5): Promise<string[]> {
    try {
      const { readdir } = await import("node:fs/promises");
      const names = await readdir(this.turnsDir);
      return names
        .filter((name) => name.endsWith(".md"))
        .sort()
        .slice(-limit)
        .map((name) => path.join(this.turnsDir, name));
    } catch {
      return [];
    }
  }

  public async countTurnArtifacts(): Promise<number> {
    const items = await this.readRecentTurnArtifacts(10_000);
    return items.length;
  }

  public async countPolicyEvents(): Promise<number> {
    try {
      const raw = await readFile(this.policyPath, "utf8");
      return raw.trim().split("\n").filter(Boolean).length;
    } catch {
      return 0;
    }
  }

  public async readRecentPolicyEvents(limit = 10): Promise<string> {
    try {
      const raw = await readFile(this.policyPath, "utf8");
      return raw
        .trim()
        .split("\n")
        .filter(Boolean)
        .slice(-limit)
        .join("\n");
    } catch {
      return "";
    }
  }

  public async buildResumeContext(): Promise<string> {
    const [summary, transcript, assistant, ledger, turnArtifacts] = await Promise.all([
      this.readSummary(),
      this.readRecentTranscript(),
      this.readAssistantSnapshot(),
      this.readRecentLedger(),
      this.readRecentTurnArtifacts(),
    ]);

    return [
      "## Local Summary",
      summary || "(none)",
      "",
      "## Recent Transcript",
      transcript || "(none)",
      "",
      "## Last Assistant Snapshot",
      assistant || "(none)",
      "",
      "## Recent Ledger",
      ledger || "(none)",
      "",
      "## Recent Turn Artifacts",
      turnArtifacts.length > 0 ? turnArtifacts.join("\n") : "(none)",
    ].join("\n");
  }

  public listArtifacts(): string[] {
    return [
      this.statePath,
      this.summaryPath,
      this.transcriptPath,
      this.assistantSnapshotPath,
      this.ledgerPath,
      this.policyPath,
      this.turnsDir,
    ];
  }

  private makeArtifactStamp(): string {
    return nowIso().replace(/[:.]/g, "-");
  }

  private sanitizeLabel(label: string): string {
    return label.replace(/[^a-z0-9_-]+/gi, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "turn";
  }

  private buildInitialState(): SessionState {
    return {
      repoRoot: this.repo.root,
      repoHash: this.repo.hash,
      branch: this.repo.branch,
      dirty: this.repo.dirty,
      mode: "agent",
      goal: "",
      taskType: "",
      workingSet: [],
      plan: [],
      currentStep: "",
      attemptCount: 0,
      openQuestions: [],
      risks: [],
      lastSummary: "",
      updatedAt: nowIso(),
    };
  }

  public async ensure(): Promise<SessionState> {
    await mkdir(this.sessionDir, { recursive: true });
    try {
      const raw = await readFile(this.statePath, "utf8");
      return SessionSchema.parse(JSON.parse(raw));
    } catch {
      const initial = this.buildInitialState();
      return this.write(initial);
    }
  }

  public async read(): Promise<SessionState> {
    const raw = await readFile(this.statePath, "utf8");
    return SessionSchema.parse(JSON.parse(raw));
  }

  public async write(state: SessionState): Promise<SessionState> {
    const next = { ...state, updatedAt: nowIso() };
    await writeFile(this.statePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    return SessionSchema.parse(next);
  }

  public async patch(update: Partial<SessionState>): Promise<SessionState> {
    const current = await this.ensure();
    const next = SessionSchema.parse({
      ...current,
      ...update,
      updatedAt: nowIso(),
    });
    return this.write(next);
  }

  public async setMode(mode: HarnessMode): Promise<SessionState> {
    return this.patch({ mode });
  }

  public async reset(): Promise<SessionState> {
    const initial = this.buildInitialState();
    const written = await this.write(initial);
    await this.writeSummary(written);
    await this.writeAssistantSnapshot("");
    return written;
  }

  public async appendLedger(type: string, payload: Record<string, unknown>): Promise<void> {
    const record: LedgerEvent = {
      ts: nowIso(),
      type,
      payload,
    };
    await mkdir(this.sessionDir, { recursive: true });
    await writeFile(this.ledgerPath, `${JSON.stringify(record)}\n`, {
      encoding: "utf8",
      flag: "a",
    });
  }

  public async appendPolicyEvent(payload: Record<string, unknown>): Promise<void> {
    const record = {
      ts: nowIso(),
      ...payload,
    };
    await mkdir(this.sessionDir, { recursive: true });
    await writeFile(this.policyPath, `${JSON.stringify(record)}\n`, {
      encoding: "utf8",
      flag: "a",
    });
  }

  public async writeAssistantTurnArtifact(
    label: string,
    mode: HarnessMode,
    text: string,
    violations: string[],
  ): Promise<string> {
    const filePath = path.join(this.turnsDir, `${this.makeArtifactStamp()}_${this.sanitizeLabel(label)}.md`);
    const content = [
      "# Assistant Turn",
      "",
      `- Mode: ${mode}`,
      `- Label: ${label}`,
      `- Violations: ${violations.length > 0 ? violations.join("; ") : "none"}`,
      "",
      "## Output",
      "",
      text.trim() || "(empty)",
      "",
    ].join("\n");
    await mkdir(this.turnsDir, { recursive: true });
    await writeFile(filePath, content, "utf8");
    return filePath;
  }

  public async writeSummary(state: SessionState): Promise<void> {
    const content = [
      "# Session Summary",
      "",
      `- Repo: ${state.repoRoot}`,
      `- Mode: ${state.mode}`,
      `- Goal: ${state.goal || "-"}`,
      `- Task type: ${state.taskType || "-"}`,
      `- Current step: ${state.currentStep || "-"}`,
      `- Working set: ${state.workingSet.length > 0 ? state.workingSet.join(", ") : "-"}`,
      `- Risks: ${state.risks.length > 0 ? state.risks.join(", ") : "-"}`,
      `- Last summary: ${state.lastSummary || "-"}`,
      `- Updated: ${state.updatedAt}`,
      "",
    ].join("\n");
    await mkdir(this.sessionDir, { recursive: true });
    await writeFile(this.summaryPath, content, "utf8");
  }
}
