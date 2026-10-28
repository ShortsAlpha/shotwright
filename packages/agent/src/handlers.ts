/** Implements every `AgentMethods` call the server can make. */
import { resolve } from "node:path";
import type { AgentMethod, AgentResult, ScreenInfo } from "@shotwright/core";
import type { AgentDriver, AgentLogger, DriverFactory } from "./drivers.ts";
import * as p from "./params.ts";
import { bootDevice, installApp, listDevices, shutdownDevice } from "./simctl.ts";
import { DEFAULT_FPS, DEFAULT_MAX_WIDTH, Streamer, type FrameSink } from "./stream.ts";
import { buildApp, listProjects } from "./xcode.ts";

type Handler<M extends AgentMethod> = (params: unknown) => Promise<AgentResult<M>>;
type HandlerTable = { readonly [M in AgentMethod]: Handler<M> };

export interface HandlerOptions {
  readonly factory: DriverFactory;
  readonly log: AgentLogger;
  readonly sink: FrameSink;
  /** Default folder for `projects.list`. */
  readonly projectsRoot: string;
}

export class Handlers {
  private driver: AgentDriver | null = null;
  private driverUdid: string | null = null;
  /** Serializes runner.ensure so two calls never start two drivers. */
  private ensureChain: Promise<unknown> = Promise.resolve();
  private readonly options: HandlerOptions;
  readonly streamer: Streamer;
  private readonly table: HandlerTable;

  constructor(options: HandlerOptions) {
    this.options = options;
    this.streamer = new Streamer(() => this.driver, options.sink, options.log);
    this.table = this.createTable();
  }

  has(method: string): method is AgentMethod {
    return Object.hasOwn(this.table, method);
  }

  dispatch(method: AgentMethod, params: unknown): Promise<unknown> {
    return this.table[method](params);
  }

  /** Stops the stream and closes the driver (agent shutdown). */
  async close(): Promise<void> {
    this.streamer.stop();
    await this.closeDriver();
  }

  private requireDriver(): AgentDriver {
    if (!this.driver) throw new p.AgentError("No device driver; run runner.ensure first", "no_driver");
    return this.driver;
  }

  private async closeDriver(): Promise<void> {
    const driver = this.driver;
    this.driver = null;
    this.driverUdid = null;
    try {
      await driver?.close?.();
    } catch (error) {
      this.options.log("warn", `Closing the driver failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  private ensureRunner(udid: string): Promise<ScreenInfo> {
    const next = this.ensureChain.then(async () => {
      if (this.driver && this.driverUdid === udid) {
        try {
          return await this.driver.screen();
        } catch (error) {
          this.options.log("warn", `Driver stopped answering (${error instanceof Error ? error.message : error}); restarting it`);
        }
      }
      await this.closeDriver();
      const device = (await listDevices().catch(() => [])).find((d) => d.udid === udid);
      const driver = await this.options.factory({ udid, ...(device && { device }), log: this.options.log });
      this.driver = driver;
      this.driverUdid = udid;
      return driver.screen();
    });
    this.ensureChain = next.catch(() => undefined);
    return next;
  }

  private createTable(): HandlerTable {
    const { log } = this.options;
    return {
      "devices.list": () => listDevices(),
      "device.boot": async (params) => {
        await bootDevice(p.udid(params));
        return null;
      },
      "device.shutdown": async (params) => {
        const udid = p.udid(params);
        if (udid === this.driverUdid) {
          this.streamer.stop();
          await this.closeDriver();
        }
        await shutdownDevice(udid);
        return null;
      },
      "projects.list": async (params) => {
        const root = p.optStr(p.asObject(params), "root");
        return listProjects(root ? resolve(root.replace(/^~(?=$|\/)/, process.env.HOME ?? "~")) : this.options.projectsRoot, log);
      },
      "app.build": async (params) => {
        const obj = p.asObject(params);
        const configuration = p.optStr(obj, "configuration") ?? "Debug";
        if (configuration !== "Debug" && configuration !== "Release") {
          throw new p.AgentError('configuration must be "Debug" or "Release"');
        }
        return buildApp(
          {
            projectPath: p.absolutePath(obj, "projectPath", [".xcodeproj", ".xcworkspace"]),
            scheme: p.arg(obj, "scheme"),
            udid: p.udid(params),
            configuration,
          },
          log,
        );
      },
      "app.install": async (params) => {
        await installApp(p.udid(params), p.absolutePath(p.asObject(params), "appPath", [".app"]));
        return null;
      },
      "runner.ensure": (params) => this.ensureRunner(p.udid(params)),
      "stream.start": async (params) => {
        const obj = p.asObject(params);
        const fps = p.optNum(obj, "fps", 0.2, 15) ?? DEFAULT_FPS;
        const maxWidth = Math.round(p.optNum(obj, "maxWidth", 100, 4000) ?? DEFAULT_MAX_WIDTH);
        this.requireDriver();
        this.streamer.start(fps, maxWidth);
        log("info", `Live view started (${fps} fps, ${maxWidth} px wide)`);
        return null;
      },
      "stream.stop": async () => {
        if (this.streamer.running) log("info", "Live view stopped");
        this.streamer.stop();
        return null;
      },
      "driver.screen": () => this.requireDriver().screen(),
      "driver.launch": async (params) => {
        await this.requireDriver().launch(p.launchOptions(params));
        return null;
      },
      "driver.terminate": async (params) => {
        await this.requireDriver().terminate(p.optStr(p.asObject(params), "bundleId"));
        return null;
      },
      "driver.home": async () => {
        await this.requireDriver().home();
        return null;
      },
      "driver.source": (params) => this.requireDriver().source(p.optStr(p.asObject(params), "bundleId")),
      "driver.screenshot": async () => {
        const png = await this.requireDriver().screenshot();
        return { png: Buffer.from(png.buffer, png.byteOffset, png.byteLength).toString("base64") };
      },
      "driver.tap": async (params) => {
        await this.requireDriver().tap(p.tapTarget(params));
        return null;
      },
      "driver.swipe": async (params) => {
        await this.requireDriver().swipe(p.swipeGesture(params));
        return null;
      },
      "driver.typeText": async (params) => {
        const obj = p.asObject(params);
        if (typeof obj.text !== "string") throw new p.AgentError('"text" must be a string');
        await this.requireDriver().typeText(obj.text, obj.into === undefined ? undefined : p.selector(obj.into));
        return null;
      },
    };
  }
}
