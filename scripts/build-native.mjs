// Build the platform helper and copy it to native/<platform>/bin, where the server
// looks for it. Only Windows has a helper today.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

if (process.platform !== "win32") {
  console.log(`No native helper for ${process.platform} yet; skipping.`);
  process.exit(0);
}

const crate = join(root, "native", "windows");
execFileSync("cargo", ["build", "--release", "--manifest-path", join(crate, "Cargo.toml")], { stdio: "inherit" });
mkdirSync(join(crate, "bin"), { recursive: true });
copyFileSync(join(crate, "target", "release", "ocu-win.exe"), join(crate, "bin", "ocu-win.exe"));
console.log("Helper ready: native/windows/bin/ocu-win.exe");
