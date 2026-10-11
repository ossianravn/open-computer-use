#!/usr/bin/env node
// open-computer-use: MCP server and command line.
//
//   open-computer-use mcp [--jev]                 run the MCP server on stdio
//   open-computer-use doctor [--jev]              check the helper, guard, approvals and Jev
//   open-computer-use apps [--installed]          list running (and installed) apps
//   open-computer-use state <app> [--window id] [--query words] [--screenshot file.jpg] [--offscreen]
//   open-computer-use find <app> <description…> [--jev]
//   open-computer-use call <tool> '<json args>' [--jev]   run any MCP tool once
//   open-computer-use approve <app.exe> | revoke <app.exe> | config
//
// Element indices survive between CLI calls: identities are kept in a temp file.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Computer, type ToolOutput } from "./computer.ts";
import { configPath, loadConfig, updateApprovedApps } from "./config.ts";
import { ToolError, errorMessage } from "./errors.ts";
import { Jev } from "./jev.ts";
import { createPlatform } from "./platform.ts";
import { runStdioServer, VERSION } from "./server.ts";
import { IdentityMap } from "./state.ts";

type Flags = { positional: string[]; options: Map<string, string | true> };

function parseArgs(argv: string[]): Flags {
  const positional: string[] = [];
  const options = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) {
      const [name, inline] = arg.slice(2).split("=", 2) as [string, string | undefined];
      const next = argv[i + 1];
      if (inline !== undefined) options.set(name, inline);
      else if (["window", "query", "screenshot", "limit"].includes(name) && next !== undefined) {
        options.set(name, next);
        i++;
      } else options.set(name, true);
    } else positional.push(arg);
  }
  return { positional, options };
}

const identityFile = join(tmpdir(), "open-computer-use", "identities.json");

function loadIdentities(): Map<number, IdentityMap> {
  try {
    const data = JSON.parse(readFileSync(identityFile, "utf8")) as Record<string, ReturnType<IdentityMap["toJSON"]>>;
    return new Map(Object.entries(data).map(([hwnd, map]) => [Number(hwnd), IdentityMap.from(map)]));
  } catch {
    return new Map();
  }
}

async function saveIdentities(computer: Computer): Promise<void> {
  const live = new Set((await computer.platform.helper.call("listWindows", { includeAll: true })).map((w) => w.hwnd));
  const data = Object.fromEntries([...computer.identityMaps].filter(([hwnd]) => live.has(hwnd)).map(([hwnd, map]) => [hwnd, map.toJSON()]));
  mkdirSync(join(tmpdir(), "open-computer-use"), { recursive: true });
  writeFileSync(identityFile, JSON.stringify(data));
}

function print(output: ToolOutput, screenshotPath?: string): void {
  console.log(output.text);
  const image = output.images?.[0];
  if (image && screenshotPath) {
    writeFileSync(screenshotPath, Buffer.from(image.data, "base64"));
    console.log(`(screenshot saved to ${screenshotPath})`);
  }
}

const USAGE = `open-computer-use ${VERSION}

Usage:
  open-computer-use mcp [--jev]              Run the MCP server on stdio
  open-computer-use doctor [--jev]           Check the helper, input guard, approvals and Jev
  open-computer-use apps [--installed]       List running apps and their windows
  open-computer-use state <app> [--window <id>] [--query <words>] [--screenshot <file.jpg>] [--offscreen]
  open-computer-use find <app> <description...>
  open-computer-use call <tool> '<json args>'   Run one tool, e.g. call click '{"app":"notepad","target":"File menu"}'
  open-computer-use call <tool> -               Same, reading the JSON arguments from stdin
  open-computer-use approve <app.exe>        Always allow an app
  open-computer-use revoke <app.exe>         Remove an app from the allow list
  open-computer-use config                   Show the config file path and contents

Flags: --jev / --no-jev turn Jev targeting on or off for this run.`;

async function main(): Promise<void> {
  const { positional, options } = parseArgs(process.argv.slice(2));
  const [command, ...rest] = positional;
  const jevFlag = options.has("jev") ? true : options.has("no-jev") ? false : undefined;
  const config = loadConfig(jevFlag === undefined ? {} : { jev: jevFlag });

  switch (command) {
    case "mcp":
      await runStdioServer(config);
      return;
    case "approve":
    case "revoke": {
      const exe = rest[0]?.toLowerCase();
      if (!exe) throw new Error(`Usage: open-computer-use ${command} <app.exe>`);
      const name = exe.endsWith(".exe") ? exe : `${exe}.exe`;
      const apps = updateApprovedApps((list) => (command === "approve" ? [...new Set([...list, name])] : list.filter((app) => app !== name)));
      console.log(`Approved apps: ${apps.join(", ") || "none"}`);
      return;
    }
    case "config":
      console.log(configPath());
      console.log(JSON.stringify(config, null, 2));
      return;
    case undefined:
    case "help":
    case "--help":
      console.log(USAGE);
      return;
  }

  const platform = createPlatform();
  const computer = new Computer({ config, platform, jev: new Jev(config.jev), identities: loadIdentities() });
  try {
    const window = options.get("window");
    const windowArg = typeof window === "string" ? { window } : {};
    switch (command) {
      case "doctor":
        print(await computer.doctor());
        break;
      case "apps":
        print(await computer.listApps({ include_installed: options.has("installed") }));
        break;
      case "state": {
        const query = options.get("query");
        const screenshot = options.get("screenshot");
        print(
          await computer.getAppState({
            app: rest[0],
            ...windowArg,
            ...(typeof query === "string" ? { query } : {}),
            ...(screenshot ? { include_screenshot: true } : {}),
            include_offscreen: options.has("offscreen"),
          }),
          typeof screenshot === "string" ? screenshot : undefined,
        );
        break;
      }
      case "find":
        print(await computer.findElement({ app: rest[0], ...windowArg, description: rest.slice(1).join(" ") }));
        break;
      case "call": {
        const [tool, json] = rest;
        // "-" reads the arguments from stdin, which avoids shell quoting of JSON.
        const raw = json === "-" ? readFileSync(0, "utf8") : json;
        const args = raw ? JSON.parse(raw) : {};
        const methods: Record<string, (args: never) => Promise<ToolOutput>> = {
          list_apps: (a) => computer.listApps(a),
          launch_app: (a) => computer.launchApp(a),
          get_app_state: (a) => computer.getAppState(a),
          find_element: (a) => computer.findElement(a),
          click: (a) => computer.click(a),
          set_value: (a) => computer.setValue(a),
          type_text: (a) => computer.typeText(a),
          press_key: (a) => computer.pressKey(a),
          scroll: (a) => computer.scroll(a),
          drag: (a) => computer.drag(a),
          perform_secondary_action: (a) => computer.secondaryAction(a),
          perform_actions: (a) => computer.performActions(a),
        };
        const method = tool ? methods[tool] : undefined;
        if (!method) throw new Error(`Unknown tool ${tool}. Tools: ${Object.keys(methods).join(", ")}`);
        print(await method(args as never), typeof options.get("screenshot") === "string" ? (options.get("screenshot") as string) : undefined);
        break;
      }
      default:
        console.log(USAGE);
        process.exitCode = 1;
    }
    await saveIdentities(computer).catch(() => undefined);
  } finally {
    platform.close();
  }
}

main().catch((error) => {
  console.error(error instanceof ToolError ? `${error.message} [${error.code}]` : `Error: ${errorMessage(error)}`);
  process.exitCode = 1;
});
