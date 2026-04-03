export type HarnessMode = "agent" | "plan" | "review" | "resume" | "ship";

export interface RepoContext {
  root: string;
  hash: string;
  branch: string;
  dirty: boolean;
}

export interface SessionState {
  repoRoot: string;
  repoHash: string;
  branch: string;
  dirty: boolean;
  mode: HarnessMode;
  goal: string;
  taskType: string;
  workingSet: string[];
  plan: string[];
  currentStep: string;
  attemptCount: number;
  openQuestions: string[];
  risks: string[];
  lastSummary: string;
  updatedAt: string;
}

export interface LedgerEvent {
  ts: string;
  type: string;
  payload: Record<string, unknown>;
}

export interface ParsedStateBlock {
  mode?: HarnessMode;
  goal?: string;
  task_type?: string;
  current_step?: string;
  working_set?: string[];
  risks?: string[];
  last_summary?: string;
}

export type SlashCommandName =
  | "agent"
  | "plan"
  | "review"
  | "resume"
  | "status"
  | "ship"
  | "help"
  | "reset"
  | "last"
  | "context"
  | "artifacts"
  | "diff"
  | "turns"
  | "policy";

export interface SlashCommand {
  name: SlashCommandName;
  arg: string;
  raw: string;
}

export interface SlashAction {
  localOutput?: string;
  promptInjection?: string;
}
