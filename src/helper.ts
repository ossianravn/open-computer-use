import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { ToolError } from "./errors.ts";
import type { HelperMethod, HelperMethods } from "./protocol.ts";

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

const DEFAULT_TIMEOUT_MS = 15_000;
const TIMEOUTS: Partial<Record<HelperMethod, number>> = { snapshot: 25_000, screenshot: 10_000 };

/**
 * A persistent connection to the platform helper. It starts the helper on first use and
 * again after a crash or a timeout, so one hung app cannot wedge the server.
 */
export class HelperClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private readonly executable: string;
  private readonly env: NodeJS.ProcessEnv;

  constructor(executable: string, env: NodeJS.ProcessEnv = process.env) {
    this.executable = executable;
    this.env = env;
  }

  private start(): ChildProcessWithoutNullStreams {
    const child = spawn(this.executable, [], { stdio: ["pipe", "pipe", "pipe"], env: this.env, windowsHide: true });
    child.on("error", (error) => this.failAll(new ToolError("helper_failed", `The platform helper failed to start: ${error.message}`)));
    child.on("exit", (code) => {
      if (this.child === child) this.child = undefined;
      this.failAll(new ToolError("helper_exited", `The platform helper exited (code ${code ?? "unknown"}). Retry the call.`));
    });
    child.stderr.on("data", (chunk: Buffer) => process.stderr.write(`[ocu-helper] ${chunk}`));
    createInterface({ input: child.stdout }).on("line", (line) => this.receive(line));
    this.child = child;
    return child;
  }

  private receive(line: string): void {
    let message: { id?: number; result?: unknown; error?: { code: string; message: string } };
    try {
      message = JSON.parse(line);
    } catch {
      process.stderr.write(`[ocu-helper] unparseable output: ${line.slice(0, 200)}\n`);
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(new ToolError(message.error.code, message.error.message));
    else pending.resolve(message.result);
  }

  private failAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  call<M extends HelperMethod>(
    method: M,
    params: HelperMethods[M]["params"],
    timeoutMs = TIMEOUTS[method] ?? DEFAULT_TIMEOUT_MS,
  ): Promise<HelperMethods[M]["result"]> {
    const child = this.child ?? this.start();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // The helper is probably blocked inside an unresponsive app; restart it.
        child.kill();
        reject(new ToolError("helper_timeout", `The platform helper did not answer ${method} within ${timeoutMs} ms. The target app may be hung.`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  close(): void {
    this.child?.stdin.end();
    this.child?.kill();
    this.child = undefined;
  }
}
