#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { connect } from "./connect.ts";
import { doctor } from "./doctor.ts";
import { DRIVER_KINDS, type DriverKind } from "./drivers.ts";

// Resolves from both src/ (tsx) and dist/ (built).
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

const DEFAULT_SERVER = "ws://localhost:3000/agent";

const USAGE = `Usage: shotwright-agent <command> [options]

Commands:
  connect       Connect this Mac to the Shotwright site and wait for commands
  doctor        Check that Xcode tools and ffmpeg are installed

Options for connect:
  --server <url>    Server WebSocket URL (default: ${DEFAULT_SERVER})
  --driver <kind>   runner (default) or fake
  --fake            Same as --driver fake: generated frames, no simulator needed
  --root <dir>      Folder to search for Xcode projects (default: the current folder)

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
        server: { type: "string" },
        fake: { type: "boolean" },
        driver: { type: "string" },
        root: { type: "string" },
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
    case "connect": {
      if (rest.length > 0) {
        console.error(`connect takes no arguments, got: ${rest.join(" ")}`);
        return 2;
      }
      const server = values.server ?? process.env.SHOTWRIGHT_SERVER ?? DEFAULT_SERVER;
      if (!/^wss?:\/\//.test(server)) {
        console.error(`--server must be a ws:// or wss:// URL, got: ${server}`);
        return 2;
      }
      const driver = values.fake ? "fake" : (values.driver ?? "runner");
      if (!DRIVER_KINDS.includes(driver as DriverKind)) {
        console.error(`--driver must be one of: ${DRIVER_KINDS.join(", ")}`);
        return 2;
      }
      // npm runs workspace scripts in the package folder; INIT_CWD is where the user ran npm.
      const projectsRoot = resolve(values.root ?? process.env.INIT_CWD ?? process.cwd());
      const code = await connect({ server, driver: driver as DriverKind, projectsRoot, agentVersion: pkg.version });
      process.exit(code);
    }
    default:
      console.error(`Unknown command: ${command}\n`);
      console.error(USAGE);
      return 2;
  }
}

process.exitCode = await main(process.argv.slice(2));
