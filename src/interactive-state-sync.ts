import { createHash } from "node:crypto";

import type { SessionStore } from "./session-store.js";
import { validateAssistantOutput } from "./policy.js";
import { applyParsedState, extractStateBlock, parseStateBlock } from "./state-sync.js";

const ANSI_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
const MAX_BUFFER_CHARS = 200_000;
const SNAPSHOT_CHARS = 8_000;
const TRANSCRIPT_CHARS = 12_000;

function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

export class InteractiveStateSync {
  private globalBuffer = "";
  private syncQueue: Promise<void> = Promise.resolve();
  private currentTurnBuffer = "";
  private currentTurnLabel = "";
  private currentTurnActive = false;
  private currentTurnLastBlockHash = "";

  public constructor(private readonly store: SessionStore) {}

  public async beginTurn(label: string): Promise<void> {
    await this.finalizeTurn();
    this.currentTurnActive = true;
    this.currentTurnLabel = label;
    this.currentTurnBuffer = "";
    this.currentTurnLastBlockHash = "";
  }

  public consume(chunk: string): void {
    const clean = stripAnsi(chunk);
    this.globalBuffer = `${this.globalBuffer}${clean}`;
    if (this.globalBuffer.length > MAX_BUFFER_CHARS) {
      this.globalBuffer = this.globalBuffer.slice(-MAX_BUFFER_CHARS);
    }

    if (!this.currentTurnActive) {
      return;
    }

    this.currentTurnBuffer = `${this.currentTurnBuffer}${clean}`;
    if (this.currentTurnBuffer.length > MAX_BUFFER_CHARS) {
      this.currentTurnBuffer = this.currentTurnBuffer.slice(-MAX_BUFFER_CHARS);
    }

    const block = extractStateBlock(this.currentTurnBuffer);
    if (!block) {
      return;
    }

    const hash = createHash("sha1").update(block).digest("hex");
    if (hash === this.currentTurnLastBlockHash) {
      return;
    }
    this.currentTurnLastBlockHash = hash;

    this.syncQueue = this.syncQueue
      .then(async () => {
        const parsed = parseStateBlock(block);
        const current = await this.store.read();
        const next = applyParsedState(current, parsed);
        const written = await this.store.write(next);
        await this.store.writeSummary(written);
        const snapshot = this.currentTurnBuffer.slice(-SNAPSHOT_CHARS);
        await this.store.writeAssistantSnapshot(snapshot);
        await this.store.appendLedger("interactive.sync", {
          mode: written.mode,
          goal: written.goal,
          currentStep: written.currentStep,
          turn: this.currentTurnLabel,
        });
      })
      .catch(() => {
        this.currentTurnLastBlockHash = "";
      });
  }

  public async finalizeTurn(): Promise<void> {
    await this.syncQueue;
    if (!this.currentTurnActive) {
      return;
    }

    const snapshot = this.currentTurnBuffer.trim();
    if (snapshot) {
      const trimmed = snapshot.slice(-TRANSCRIPT_CHARS);
      const current = await this.store.read();
      const violations = validateAssistantOutput(current.mode, trimmed);
      await this.store.writeAssistantSnapshot(trimmed);
      await this.store.appendTranscript("assistant", trimmed);
      const artifactPath = await this.store.writeAssistantTurnArtifact(
        this.currentTurnLabel,
        current.mode,
        trimmed,
        violations,
      );
      if (violations.length > 0) {
        await this.store.appendPolicyEvent({
          kind: "assistant_output_validation",
          mode: current.mode,
          turn: this.currentTurnLabel,
          violations,
          artifactPath,
        });
      }
      await this.store.appendLedger("interactive.turn.finalized", {
        turn: this.currentTurnLabel,
        chars: trimmed.length,
        artifactPath,
        violations,
      });
    }

    this.currentTurnActive = false;
    this.currentTurnLabel = "";
    this.currentTurnBuffer = "";
    this.currentTurnLastBlockHash = "";
  }

  public async flush(): Promise<void> {
    await this.finalizeTurn();
  }
}
