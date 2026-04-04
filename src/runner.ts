import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { resolveCodexBin } from "./pty.js";

export interface RunnerCallbacks {
  onOutput?: (text: string) => void;
  onWarning?: (message: string) => void;
}

export interface RunnerTurnOptions {
  model?: string;
  reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
  sandboxMode?: "read-only" | "workspace-write" | "danger-full-access";
  approvalPolicy?: "untrusted" | "on-failure" | "on-request" | "never";
  fullAuto?: boolean;
}

export interface RunnerTurnResult {
  exitCode: number;
  lastMessage: string;
  streamedOutput: string;
  warnings: string[];
}

export interface Runner {
  runTurn(prompt: string, options?: RunnerTurnOptions, callbacks?: RunnerCallbacks): Promise<RunnerTurnResult>;
  kill(): void;
}

type StreamKind = "stdout" | "stderr";

function ensureTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}

function parseJsonLine(line: string): unknown | null {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return null;
  }
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function readContentText(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    const fragments = value
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        if (item && typeof item === "object") {
          const maybeText = (item as Record<string, unknown>).text;
          return typeof maybeText === "string" ? maybeText : "";
        }
        return "";
      })
      .filter(Boolean);
    return fragments.length > 0 ? fragments.join("") : null;
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return (
      readString(record.text)
      ?? readContentText(record.content)
      ?? readString(record.delta)
      ?? null
    );
  }

  return null;
}

function eventType(value: unknown): string {
  if (!value || typeof value !== "object") {
    return "";
  }
  const type = (value as Record<string, unknown>).type;
  return typeof type === "string" ? type.toLowerCase() : "";
}

function extractOutputText(event: unknown): string | null {
  if (!event || typeof event !== "object") {
    return null;
  }

  const record = event as Record<string, unknown>;
  const direct = readString(record.delta)
    ?? readString(record.text)
    ?? readContentText(record.content)
    ?? readString(record.output)
    ?? null;

  if (direct) {
    return direct;
  }

  const type = eventType(event);
  if (type.includes("error") || type.includes("warning")) {
    return null;
  }

  if (record.message && typeof record.message === "object") {
    return extractOutputText(record.message);
  }

  if (type.includes("assistant") || type.includes("message") || type.includes("response")) {
    return readString(record.message) ?? null;
  }

  return null;
}

function extractWarningText(event: unknown): string | null {
  if (!event || typeof event !== "object") {
    return null;
  }

  const record = event as Record<string, unknown>;
  const type = eventType(event);
  if (type.includes("error") || type.includes("warning") || type.includes("failed")) {
    return readString(record.message)
      ?? readString(record.error)
      ?? readString((record.error as Record<string, unknown> | undefined)?.message)
      ?? readString(record.stderr)
      ?? null;
  }

  return readString((record.error as Record<string, unknown> | undefined)?.message)
    ?? null;
}

function readTempRoot(): string {
  return process.env.CODEX_AGENT_TMPDIR?.trim() || path.join(os.tmpdir(), "codexcc");
}

export class ExecJsonRunner implements Runner {
  private activeChild: ChildProcessWithoutNullStreams | null = null;

  public constructor(private readonly cwd: string) {}

  public async runTurn(
    prompt: string,
    options: RunnerTurnOptions = {},
    callbacks: RunnerCallbacks = {},
  ): Promise<RunnerTurnResult> {
    if (this.activeChild) {
      throw new Error("runner is already executing a turn");
    }

    const tempRoot = readTempRoot();
    await mkdir(tempRoot, { recursive: true });
    const turnDir = await mkdtemp(path.join(tempRoot, "turn-"));
    const outFile = path.join(turnDir, "last-message.txt");
    const bin = resolveCodexBin();

    const args = [
      "exec",
      "--json",
      "--color",
      "never",
    ];

    if (options.model) {
      args.push("-m", options.model);
    }
    if (options.fullAuto) {
      args.push("--full-auto");
    } else {
      args.push("--sandbox", options.sandboxMode ?? "workspace-write");
      args.push("--ask-for-approval", options.approvalPolicy ?? "on-request");
    }
    if (options.reasoningEffort) {
      args.push("-c", `reasoning.effort="${options.reasoningEffort}"`);
    }
    args.push(
      "-C",
      this.cwd,
      "--skip-git-repo-check",
      "--output-last-message",
      outFile,
      "-",
    );

    const child = spawn(
      bin,
      args,
      {
        cwd: this.cwd,
        env: process.env,
        stdio: "pipe",
      },
    );
    this.activeChild = child;

    const warnings: string[] = [];
    let streamedOutput = "";
    let stdoutBuffer = "";
    let stderrBuffer = "";

    const consumeLine = (line: string, stream: StreamKind): void => {
      const trimmed = line.trim();
      if (!trimmed) {
        return;
      }

      const parsed = parseJsonLine(trimmed);
      if (parsed) {
        const warning = extractWarningText(parsed);
        if (warning) {
          const normalized = ensureTrailingNewline(warning);
          warnings.push(warning);
          callbacks.onWarning?.(normalized);
        }

        const output = extractOutputText(parsed);
        if (output) {
          const normalized = ensureTrailingNewline(output);
          streamedOutput += normalized;
          callbacks.onOutput?.(normalized);
        }
        return;
      }

      const normalized = ensureTrailingNewline(trimmed);
      if (stream === "stderr") {
        warnings.push(trimmed);
        callbacks.onWarning?.(normalized);
        return;
      }

      streamedOutput += normalized;
      callbacks.onOutput?.(normalized);
    };

    const consumeChunk = (chunk: string, stream: StreamKind): void => {
      const next = `${stream === "stdout" ? stdoutBuffer : stderrBuffer}${chunk}`;
      const lines = next.split(/\r?\n/);
      const trailing = lines.pop() ?? "";
      for (const line of lines) {
        consumeLine(line, stream);
      }
      if (stream === "stdout") {
        stdoutBuffer = trailing;
      } else {
        stderrBuffer = trailing;
      }
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => consumeChunk(chunk, "stdout"));
    child.stderr.on("data", (chunk: string) => consumeChunk(chunk, "stderr"));

    child.stdin.end(prompt);

    try {
      const exitCode = await new Promise<number>((resolve, reject) => {
        child.on("error", reject);
        child.on("exit", (code) => resolve(code ?? 1));
      });

      if (stdoutBuffer.trim()) {
        consumeLine(stdoutBuffer, "stdout");
      }
      if (stderrBuffer.trim()) {
        consumeLine(stderrBuffer, "stderr");
      }

      let lastMessage = "";
      try {
        lastMessage = await readFile(outFile, "utf8");
      } catch {
        lastMessage = "";
      }

      return {
        exitCode,
        lastMessage,
        streamedOutput,
        warnings,
      };
    } finally {
      this.activeChild = null;
      await rm(turnDir, { recursive: true, force: true });
    }
  }

  public kill(): void {
    this.activeChild?.kill();
    this.activeChild = null;
  }
}
