import { execFileSync } from "node:child_process";
import process from "node:process";
import { spawn } from "node:child_process";

export interface PtyLike {
  write(data: string): void;
  kill(): void;
  onData(listener: (chunk: string) => void): void;
  onExit(listener: (exitCode: number) => void): void;
}

function resolveCodexBin(): string {
  const configured = process.env.CODEX_BIN?.trim();
  if (configured) {
    return configured;
  }
  try {
    return execFileSync("which", ["codex"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || "codex";
  } catch {
    return "/usr/local/bin/codex";
  }
}

export async function spawnCodexPty(args: string[], cwd: string): Promise<PtyLike> {
  const bin = resolveCodexBin();
  try {
    const mod = await import("node-pty");
    const pty = mod.spawn(bin, args, {
      cwd,
      cols: process.stdout.columns || 120,
      rows: process.stdout.rows || 40,
      env: process.env,
      name: "xterm-color",
    });

    return {
      write(data: string): void {
        pty.write(data);
      },
      kill(): void {
        pty.kill();
      },
      onData(listener: (chunk: string) => void): void {
        pty.onData(listener);
      },
      onExit(listener: (exitCode: number) => void): void {
        pty.onExit((event) => listener(event.exitCode));
      },
    };
  } catch {
    const child = spawn(bin, args, {
      cwd,
      env: process.env,
      stdio: "pipe",
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    return {
      write(data: string): void {
        child.stdin.write(data);
      },
      kill(): void {
        child.kill();
      },
      onData(listener: (chunk: string) => void): void {
        child.stdout.on("data", listener);
        child.stderr.on("data", listener);
      },
      onExit(listener: (exitCode: number) => void): void {
        child.on("exit", (code) => listener(code ?? 0));
      },
    };
  }
}
