// Build the platform helper and copy it to native/<platform>/bin, where the server
// looks for it. macOS builds a universal binary for Apple silicon and Intel.
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

if (process.platform === "darwin") {
  const native = join(root, "native", "macos");
  const build = join(native, "build");
  mkdirSync(build, { recursive: true });
  mkdirSync(join(native, "bin"), { recursive: true });
  const sources = readdirSync(join(native, "Sources")).filter((name) => name.endsWith(".swift")).sort().map((name) => join(native, "Sources", name));
  const slices = ["arm64", "x86_64"].map((arch) => {
    const output = join(build, `ocu-mac-${arch}`);
    execFileSync("xcrun", ["swiftc", "-swift-version", "5", "-O", "-target", `${arch}-apple-macosx14.0`,
      "-module-cache-path", join(tmpdir(), "ocu-swift-module-cache"), ...sources, "-o", output], { stdio: "inherit" });
    return output;
  });
  const output = join(native, "bin", "ocu-mac");
  execFileSync("lipo", ["-create", ...slices, "-output", output], { stdio: "inherit" });
  execFileSync("codesign", ["--force", "--sign", "-", "--identifier", "org.open-cu.helper", output], { stdio: "inherit" });
  chmodSync(output, 0o755);
  console.log("Helper ready: native/macos/bin/ocu-mac (macOS 14+, arm64 + x86_64)");
  process.exit(0);
}

if (process.platform !== "win32") {
  console.log(`No native helper for ${process.platform} yet; skipping.`);
  process.exit(0);
}

const crate = join(root, "native", "windows");
execFileSync("cargo", ["build", "--release", "--manifest-path", join(crate, "Cargo.toml")], { stdio: "inherit" });
mkdirSync(join(crate, "bin"), { recursive: true });
copyFileSync(join(crate, "target", "release", "ocu-win.exe"), join(crate, "bin", "ocu-win.exe"));
console.log("Helper ready: native/windows/bin/ocu-win.exe");
