#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { doctor } from "./doctor.ts";

// Resolves from both src/ (tsx) and dist/ (built).
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

const USAGE = `Usage: shotwright-agent <command>

Commands:
  doctor        Check that Xcode tools, ffmpeg and idb_companion are installed

Options:
  -v, --version Print the agent version
  -h, --help    Show this help`;

async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        version: { type: "boolean", short: "v" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(USAGE);
    return 2;
  }

  const { values, positionals } = parsed;
  if (values.version) {
    console.log(pkg.version);
    return 0;
  }

  const [command, ...rest] = positionals;
  if (values.help || command === undefined) {
    console.log(USAGE);
    return 0;
  }

  switch (command) {
    case "doctor":
      if (rest.length > 0) {
        console.error(`doctor takes no arguments, got: ${rest.join(" ")}`);
        return 2;
      }
      return doctor(pkg.version);
    default:
      console.error(`Unknown command: ${command}\n`);
      console.error(USAGE);
      return 2;
  }
}

process.exitCode = await main(process.argv.slice(2));
