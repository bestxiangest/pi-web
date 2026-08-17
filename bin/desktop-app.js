"use strict";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { spawn } = require("node:child_process");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("node:path");

function resolveElectronExecutable(pkgDir, options = {}) {
  const resolveModule = options.resolveModule ?? require.resolve;
  const loadModule = options.loadModule ?? require;

  try {
    const electronModule = resolveModule("electron", { paths: [pkgDir] });
    const executable = loadModule(electronModule);
    if (typeof executable === "string" && executable.length > 0) return executable;
  } catch (error) {
    const wrapped = new Error(
      "Electron is required for pi-web app. Reinstall pi-web without --omit=optional.",
    );
    wrapped.cause = error;
    throw wrapped;
  }

  throw new Error("Electron did not provide a valid executable path.");
}

function launchDesktopApp(url, options = {}) {
  const pkgDir = options.pkgDir ?? path.join(__dirname, "..");
  const electronExecutable = options.electronExecutable ?? resolveElectronExecutable(pkgDir);
  const spawnProcess = options.spawnProcess ?? spawn;
  const env = { ...(options.env ?? process.env), PI_WEB_APP_URL: url };
  delete env.ELECTRON_RUN_AS_NODE;

  return spawnProcess(electronExecutable, [path.join(pkgDir, "desktop")], {
    cwd: pkgDir,
    env,
    stdio: "inherit",
  });
}

module.exports = { launchDesktopApp, resolveElectronExecutable };
