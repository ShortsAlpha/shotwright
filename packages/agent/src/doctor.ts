import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

interface ToolCheck {
  readonly name: string;
  readonly args: readonly string[];
  /** Optional tools are reported but do not fail `doctor`. */
  readonly required: boolean;
  readonly install: string;
  /** Turns the command's output into a short version string. */
  readonly parse: (output: string) => string;
}

type CheckResult =
  | { readonly status: "ok"; readonly version: string }
  | { readonly status: "missing" }
  | { readonly status: "error"; readonly detail: string };

const firstLine = (output: string): string =>
  output.split("\n").find((line) => line.trim() !== "")?.trim() ?? "";

const TOOLS: readonly ToolCheck[] = [
  {
    name: "xcrun",
    args: ["--version"],
    required: true,
    install: "xcode-select --install",
    parse: (out) => /version\s+([\w.]+?)\.?$/m.exec(out)?.[1] ?? firstLine(out),
  },
  {
    name: "xcodebuild",
    args: ["-version"],
    required: true,
    install: "Install Xcode, then: sudo xcode-select -s /Applications/Xcode.app",
    parse: (out) => {
      const xcode = /^Xcode\s+(\S+)/m.exec(out)?.[1];
      const build = /^Build version\s+(\S+)/m.exec(out)?.[1];
      return xcode ? `Xcode ${xcode}${build ? ` (${build})` : ""}` : firstLine(out);
    },
  },
  {
    name: "ffmpeg",
    args: ["-version"],
    required: true,
    install: "brew install ffmpeg",
    parse: (out) => /ffmpeg version\s+(\S+)/.exec(out)?.[1] ?? firstLine(out),
  },
];

async function check(tool: ToolCheck): Promise<CheckResult> {
  try {
    const { stdout, stderr } = await run(tool.name, [...tool.args], { timeout: 20_000 });
    return { status: "ok", version: tool.parse(stdout.trim() ? stdout : stderr) || "unknown version" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
    const { stderr, message } = error as { stderr?: string; message: string };
    return { status: "error", detail: firstLine(stderr ?? "") || message };
  }
}

/** Prints the status of each external tool. Returns the process exit code. */
export async function doctor(agentVersion: string): Promise<number> {
  console.log(`shotwright-agent ${agentVersion} doctor\n`);

  const results = await Promise.all(TOOLS.map(check));
  const width = Math.max(...TOOLS.map((t) => t.name.length));
  let failed = 0;

  TOOLS.forEach((tool, i) => {
    const result = results[i]!;
    const name = tool.name.padEnd(width);
    const optional = tool.required ? "" : " (optional)";
    switch (result.status) {
      case "ok":
        console.log(`  ok       ${name}  ${result.version}`);
        break;
      case "missing":
        console.log(`  missing  ${name}  not found on PATH${optional}; install: ${tool.install}`);
        break;
      case "error":
        console.log(`  error    ${name}  ${result.detail}${optional}; fix: ${tool.install}`);
        break;
    }
    if (result.status !== "ok" && tool.required) failed++;
  });

  console.log(
    failed === 0
      ? "\nAll required tools are installed."
      : `\n${failed} required tool${failed === 1 ? " is" : "s are"} missing or broken.`,
  );
  return failed === 0 ? 0 : 1;
}
