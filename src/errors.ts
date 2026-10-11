/**
 * An error the agent should see as a tool result. `code` is stable for programs; the
 * message is written for the model and says what to do next.
 */
export class ToolError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "ToolError";
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
