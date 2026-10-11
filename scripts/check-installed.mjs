// Connect to an installed open-cu MCP server the way a client does, list its tools
// and run the read-only list_apps tool. Used to verify plugin installations.
// Run: node scripts/check-installed.mjs <path to the installed dist/cli.mjs>
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const cli = process.argv[2];
if (!cli) {
  console.error("Usage: node scripts/check-installed.mjs <installed dist/cli.mjs>");
  process.exit(2);
}
const transport = new StdioClientTransport({ command: process.execPath, args: [cli, "mcp"], stderr: "pipe" });
const client = new Client({ name: "open-cu-install-check", version: "0.0.0" });
await client.connect(transport);
const { tools } = await client.listTools();
const result = await client.callTool({ name: "list_apps", arguments: {} });
const text = result.content.find((part) => part.type === "text")?.text ?? "";
await client.close();
const server = client.getServerVersion();
console.log(`server: ${server?.name} ${server?.version}`);
console.log(`tools (${tools.length}): ${tools.map((tool) => tool.name).join(", ")}`);
console.log(`list_apps: ${result.isError ? "error" : "ok"}, ${text.split("\n").length - 1} app line(s)`);
if (result.isError || tools.length < 12) process.exit(1);
