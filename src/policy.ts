import type { HarnessMode } from "./types.js";

const MODE_POLICIES: Record<HarnessMode, string[]> = {
  agent: [
    "Act autonomously in small verified steps.",
    "Prefer the smallest useful action over long speculative analysis.",
    "If you change files, explain what was verified afterward.",
  ],
  plan: [
    "Do not edit files or claim to have changed anything.",
    "Do not recommend broad rewrites when a focused plan is enough.",
    "Return a compact execution plan with acceptance criteria and stop conditions.",
  ],
  review: [
    "Findings first, ordered by severity.",
    "Do not silently rewrite code unless the user explicitly asks for fixes.",
    "Prioritize bugs, regressions, weak assumptions, and missing verification.",
  ],
  resume: [
    "Reconstruct the current objective from durable local context before proposing new work.",
    "Prefer continuity over re-scanning the entire repository.",
    "Call out uncertainty when local artifacts are stale or inconsistent.",
  ],
  ship: [
    "Bias toward verification, closure, and residual-risk reporting.",
    "Do not broaden scope with unrelated cleanups.",
    "Summarize what changed, what was checked, and what still needs human review.",
  ],
};

export function buildModePolicy(mode: HarnessMode): string {
  const rules = MODE_POLICIES[mode];
  return rules.map((rule) => `- ${rule}`).join("\n");
}

function hasAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

export function validateAssistantOutput(mode: HarnessMode, text: string): string[] {
  const normalized = text.toLowerCase();
  const violations: string[] = [];

  if (mode === "plan") {
    if (hasAny(normalized, [/\bi changed\b/, /\bi updated\b/, /\bi modified\b/, /\bapplied\b/, /\bpatched\b/])) {
      violations.push("plan mode output suggests file changes instead of plan-only behavior");
    }
  }

  if (mode === "review") {
    if (hasAny(normalized, [/\bi changed\b/, /\bi updated\b/, /\bi modified\b/, /\bapplied\b/, /\bpatched\b/])) {
      violations.push("review mode output suggests direct code changes instead of findings-first behavior");
    }
    if (!hasAny(normalized, [/\bfinding\b/, /\bfindings\b/, /\brisk\b/, /\bissue\b/, /\bbug\b/])) {
      violations.push("review mode output may be missing findings-first structure");
    }
  }

  if (mode === "ship") {
    if (!hasAny(normalized, [/\bverif/, /\bchecked\b/, /\btested\b/])) {
      violations.push("ship mode output may be missing verification detail");
    }
    if (!hasAny(normalized, [/\brisk\b/, /\bresidual\b/, /\bwatch\b/])) {
      violations.push("ship mode output may be missing residual risk reporting");
    }
  }

  if (mode === "resume") {
    if (!hasAny(normalized, [/\bresume\b/, /\bcurrent\b/, /\bnext\b/, /\bstate\b/, /\bsummary\b/])) {
      violations.push("resume mode output may be missing continuity-oriented reconstruction");
    }
  }

  return violations;
}
