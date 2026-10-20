// Release consistency checks: manifests parse and agree, the skill is well formed,
// and the shipped artifacts (bundle and helper) exist and are newer than their sources.
// Run: npm run validate
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const problems = [];
const read = (path) => readFileSync(join(root, path), "utf8");
const json = (path) => {
  try {
    return JSON.parse(read(path));
  } catch (error) {
    problems.push(`${path}: ${error.message}`);
    return {};
  }
};

const pkg = json("package.json");
const portable = json("plugin.json");
const claude = json(".claude-plugin/plugin.json");
const claudeMarket = json(".claude-plugin/marketplace.json");
const codexMarket = json(".agents/plugins/marketplace.json");
const mcp = json("mcp.json");
const serverVersion = read("src/server.ts").match(/export const VERSION = "([^"]+)"/)?.[1];

for (const [label, version] of [
  ["plugin.json", portable.version],
  [".claude-plugin/plugin.json", claude.version],
  ["src/server.ts VERSION", serverVersion],
]) {
  if (version !== pkg.version) problems.push(`${label} version ${version} differs from package.json ${pkg.version}`);
}
for (const [label, name] of [
  ["plugin.json", portable.name],
  [".claude-plugin/plugin.json", claude.name],
  [".claude-plugin/marketplace.json plugin", claudeMarket.plugins?.[0]?.name],
  [".agents/plugins/marketplace.json plugin", codexMarket.plugins?.[0]?.name],
]) {
  if (name !== "open-cu") problems.push(`${label} name is ${name}, expected open-cu`);
}
if (!mcp.mcpServers?.["open-cu"]?.args?.[0]?.startsWith("${PLUGIN_ROOT}/")) problems.push("mcp.json must start open-cu from ${PLUGIN_ROOT}");

const skillPath = "skills/open-cu/SKILL.md";
const skill = existsSync(join(root, skillPath)) ? read(skillPath) : "";
const front = skill.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
if (!/^name: open-cu$/m.test(front)) problems.push(`${skillPath}: frontmatter name must be open-cu`);
if (!/^description: .{40,}$/m.test(front)) problems.push(`${skillPath}: frontmatter needs a description`);

const newest = (dir, pattern) => {
  let latest = 0;
  const walk = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (pattern.test(entry.name)) latest = Math.max(latest, statSync(full).mtimeMs);
    }
  };
  walk(join(root, dir));
  return latest;
};
const artifact = (path, sourceDir, pattern, rebuild) => {
  const full = join(root, path);
  if (!existsSync(full)) return problems.push(`${path} is missing; run ${rebuild}`);
  if (statSync(full).mtimeMs < newest(sourceDir, pattern) && !committedTogether(path, sourceDir)) {
    problems.push(`${path} is older than ${sourceDir}; run ${rebuild}`);
  }
};
// A fresh clone writes files in checkout order, not build order. Accept a clean
// committed artifact only if its last commit also contains the latest sources.
// Dirty/untracked sources still require a rebuild; no cross-compilation is needed
// merely to validate the other platform's unchanged, committed binary.
const committedTogether = (path, sourceDir) => {
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  try {
    if (git("status", "--porcelain", "--untracked-files=all", "--", path, sourceDir)) return false;
    const artifactCommit = git("log", "-1", "--format=%H", "--", path);
    if (!artifactCommit) return false;
    git("diff", "--quiet", artifactCommit, "HEAD", "--", sourceDir);
    return true;
  } catch { return false; }
};
artifact("dist/cli.mjs", "src", /\.ts$/, "npm run build:js");
artifact("native/windows/bin/ocu-win.exe", "native/windows/src", /\.rs$/, "npm run build:native");
artifact("native/macos/bin/ocu-mac", "native/macos/Sources", /\.swift$/, "npm run build:native on macOS");
const macVersion = read("native/macos/Sources/main.swift").match(/"version": "([^"]+)"/)?.[1];
if (macVersion !== pkg.version) problems.push(`macOS helper version ${macVersion} differs from package.json ${pkg.version}`);

if (problems.length) {
  console.error(`validate: ${problems.length} problem(s)\n- ${problems.join("\n- ")}`);
  process.exit(1);
}
console.log(`validate: open-cu ${pkg.version} manifests, skill and artifacts are consistent (${relative(process.cwd(), root) || "."}).`);
