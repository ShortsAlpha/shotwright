import { execFile, spawn } from "node:child_process";

/** A failed command, with an error message built from the end of its output. */
export class CommandError extends Error {
  readonly output: string;
  readonly exitCode: number | null;

  constructor(message: string, output: string, exitCode: number | null) {
    super(message);
    this.name = "CommandError";
    this.output = output;
    this.exitCode = exitCode;
  }
}

export interface RunOptions {
  readonly timeoutMs?: number;
  readonly maxBuffer?: number;
}

const lastLines = (text: string, count: number): string =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .slice(-count)
    .join(" | ");

/** Runs a command (no shell) and resolves with its output. */
export function run(
  command: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      { timeout: options.timeoutMs ?? 60_000, maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ stdout, stderr });
          return;
        }
        const output = `${stderr}\n${stdout}`;
        const timedOut = error.killed && error.signal === "SIGTERM";
        const detail = timedOut
          ? `timed out after ${Math.round((options.timeoutMs ?? 60_000) / 1000)} s`
          : lastLines(stderr, 3) || lastLines(stdout, 3) || error.message;
        const label = [command, ...args.slice(0, 2)].join(" ");
        reject(new CommandError(`${label}: ${detail}`, output, typeof error.code === "number" ? error.code : null));
      },
    );
  });
}

/** Runs a command with binary stdin and resolves with its binary stdout. */
export function pipeThrough(
  command: string,
  args: readonly string[],
  input: Uint8Array,
  timeoutMs = 10_000,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new CommandError(`${command}: timed out after ${timeoutMs} ms`, err, null));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString()));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new CommandError(`${command} exited with ${code}: ${lastLines(err, 3)}`, err, code));
    });
    child.stdin.on("error", () => {
      // The process may exit before reading all input; the close handler reports it.
    });
    child.stdin.end(input);
  });
}

/**
 * Runs a long command, calling `onLine` for every line of stdout and stderr.
 * Resolves with the exit code and the last lines of output.
 */
export function runStreaming(
  command: string,
  args: readonly string[],
  options: { timeoutMs: number; onLine: (line: string) => void; tailLines?: number },
): Promise<{ code: number | null; tail: string[] }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"] });
    const tail: string[] = [];
    const keep = options.tailLines ?? 80;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new CommandError(`${command}: timed out after ${Math.round(options.timeoutMs / 1000)} s`, tail.join("\n"), null));
    }, options.timeoutMs);

    const attach = (stream: NodeJS.ReadableStream) => {
      let buffer = "";
      stream.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        let index: number;
        while ((index = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, index).trimEnd();
          buffer = buffer.slice(index + 1);
          tail.push(line);
          if (tail.length > keep) tail.shift();
          options.onLine(line);
        }
      });
    };
    attach(child.stdout);
    attach(child.stderr);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, tail });
    });
  });
}
