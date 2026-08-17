import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { launchDesktopApp, resolveElectronExecutable } = require("../bin/desktop-app.js");
const { getUrlOrigin, isInternalUrl, isSafeExternalUrl } = require("../desktop/window-policy.cjs");

test("resolves Electron from the Pi Web package", () => {
  const calls = [];
  const executable = resolveElectronExecutable("/pkg", {
    resolveModule(specifier, options) {
      calls.push({ specifier, options });
      return "/pkg/node_modules/electron/index.js";
    },
    loadModule(modulePath) {
      assert.equal(modulePath, "/pkg/node_modules/electron/index.js");
      return "/runtime/electron";
    },
  });

  assert.equal(executable, "/runtime/electron");
  assert.deepEqual(calls, [{ specifier: "electron", options: { paths: ["/pkg"] } }]);
});

test("reports how to restore an omitted Electron dependency", () => {
  assert.throws(
    () => resolveElectronExecutable("/pkg", {
      resolveModule() {
        throw new Error("missing");
      },
    }),
    /Reinstall pi-web without --omit=optional/,
  );
});

test("launches the Electron entry with an isolated app URL", () => {
  const calls = [];
  const child = {};
  const result = launchDesktopApp("http://127.0.0.1:30141", {
    pkgDir: "/pkg",
    electronExecutable: "/runtime/electron",
    env: { KEEP: "yes", ELECTRON_RUN_AS_NODE: "1" },
    spawnProcess(command, args, options) {
      calls.push({ command, args, options });
      return child;
    },
  });

  assert.equal(result, child);
  assert.equal(calls[0].command, "/runtime/electron");
  assert.deepEqual(calls[0].args, [path.join("/pkg", "desktop")]);
  assert.equal(calls[0].options.cwd, "/pkg");
  assert.equal(calls[0].options.stdio, "inherit");
  assert.equal(calls[0].options.env.KEEP, "yes");
  assert.equal(calls[0].options.env.PI_WEB_APP_URL, "http://127.0.0.1:30141");
  assert.equal(calls[0].options.env.ELECTRON_RUN_AS_NODE, undefined);
});

test("desktop navigation policy isolates the app origin", () => {
  const origin = getUrlOrigin("http://127.0.0.1:30141/session?id=1");
  assert.equal(origin, "http://127.0.0.1:30141");
  assert.equal(isInternalUrl("http://127.0.0.1:30141/api/sessions", origin), true);
  assert.equal(isInternalUrl("http://127.0.0.1:30142/", origin), false);
  assert.equal(isInternalUrl("https://example.com/", origin), false);
  assert.equal(isSafeExternalUrl("https://example.com/"), true);
  assert.equal(isSafeExternalUrl("mailto:hello@example.com"), true);
  assert.equal(isSafeExternalUrl("file:///tmp/private"), false);
  assert.equal(isSafeExternalUrl("invalid"), false);
});
