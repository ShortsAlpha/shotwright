import { execFile } from "node:child_process";

export interface ExecResult {
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs a command without a shell; rejects with stderr in the message on a non-zero exit or timeout. */
export function exec(
  file: string,
  args: readonly string[],
  options: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      { timeout: options.timeoutMs ?? 60_000, env: options.env ?? process.env, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr).trim().split("\n").slice(-5).join("\n");
          const killed = (error as { killed?: boolean }).killed ? " (timed out)" : "";
          reject(new Error(`${file} ${args.slice(0, 3).join(" ")} failed${killed}: ${detail || error.message}`));
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}
