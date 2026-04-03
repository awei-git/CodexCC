import { readFile } from "node:fs/promises";

import type { ParsedStateBlock, SessionState } from "./types.js";

const STATE_BLOCK_RE = /```state\s*\n([\s\S]*?)```/g;

export function extractStateBlock(text: string): string | null {
  const matches = [...text.matchAll(STATE_BLOCK_RE)];
  const last = matches.at(-1);
  return last?.[1]?.trim() ?? null;
}

export function parseStateBlock(block: string): ParsedStateBlock {
  const parsed: ParsedStateBlock = {};
  let currentList: "working_set" | "risks" | null = null;

  for (const rawLine of block.split("\n")) {
    const line = rawLine.trimEnd();
    if (!line.trim()) {
      continue;
    }

    if (line.startsWith("- ") && currentList) {
      parsed[currentList] ??= [];
      parsed[currentList]?.push(line.slice(2).trim());
      continue;
    }

    const match = /^([a-z_]+):\s*(.*)$/i.exec(line);
    if (!match) {
      continue;
    }

    const key = match[1] ?? "";
    const value = match[2] ?? "";
    const normalized = key as keyof ParsedStateBlock;
    if (normalized === "working_set" || normalized === "risks") {
      currentList = normalized;
      if (value) {
        parsed[normalized] = [value];
        currentList = null;
      } else {
        parsed[normalized] = [];
      }
      continue;
    }

    currentList = null;
    if (normalized === "mode") {
      parsed.mode = value as NonNullable<ParsedStateBlock["mode"]>;
    } else if (normalized in parsed || normalized === "goal" || normalized === "task_type" || normalized === "current_step" || normalized === "last_summary") {
      parsed[normalized] = value;
    }
  }

  return parsed;
}

export async function readStateSource(filePath?: string): Promise<string> {
  if (!filePath) {
    const chunks: string[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(String(chunk));
    }
    return chunks.join("");
  }
  return readFile(filePath, "utf8");
}

export function applyParsedState(current: SessionState, parsed: ParsedStateBlock): SessionState {
  return {
    ...current,
    mode: parsed.mode ?? current.mode,
    goal: parsed.goal ?? current.goal,
    taskType: parsed.task_type ?? current.taskType,
    currentStep: parsed.current_step ?? current.currentStep,
    workingSet: parsed.working_set ?? current.workingSet,
    risks: parsed.risks ?? current.risks,
    lastSummary: parsed.last_summary ?? current.lastSummary,
  };
}
