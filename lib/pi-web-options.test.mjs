import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { parseLaunchOptions } = require("../bin/pi-web-options.js");

test("opens the browser by default", () => {
  assert.deepEqual(parseLaunchOptions([], {}), {
    mode: "web",
    port: "30141",
    hostname: "127.0.0.1",
    openBrowser: true,
  });
});

test("supports the no-open CLI option", () => {
  assert.equal(parseLaunchOptions(["--no-open"], {}).openBrowser, false);
});

test("supports truthy PI_WEB_NO_OPEN values", () => {
  for (const value of ["1", "true", "TRUE", "yes", "on"]) {
    assert.equal(parseLaunchOptions([], { PI_WEB_NO_OPEN: value }).openBrowser, false);
  }
});

test("does not disable browser opening for false PI_WEB_NO_OPEN values", () => {
  for (const value of ["0", "false", "off", ""]) {
    assert.equal(parseLaunchOptions([], { PI_WEB_NO_OPEN: value }).openBrowser, true);
  }
});

test("preserves port and hostname options", () => {
  assert.deepEqual(
    parseLaunchOptions(["-p", "8080", "-H", "0.0.0.0"], {}),
    {
      mode: "web",
      port: "8080",
      hostname: "0.0.0.0",
      openBrowser: true,
    },
  );
});

test("supports the app command", () => {
  assert.deepEqual(
    parseLaunchOptions(["app", "-p", "40141"], { PI_WEB_NO_OPEN: "1" }),
    {
      mode: "app",
      port: "40141",
      hostname: "127.0.0.1",
      openBrowser: true,
    },
  );
});

test("rejects unknown commands and no-open app launches", () => {
  assert.throws(
    () => parseLaunchOptions(["desktop"], {}),
    /Unknown command: desktop/,
  );
  assert.throws(
    () => parseLaunchOptions(["app", "extra"], {}),
    /Unknown command: app extra/,
  );
  assert.throws(
    () => parseLaunchOptions(["app", "--no-open"], {}),
    /--no-open option cannot be used with the app command/,
  );
});

test("rejects port values that could inject cmd arguments", () => {
  assert.throws(
    () => parseLaunchOptions(["-p", "30141&whoami"], {}),
    /Port must be a non-negative integer/,
  );
  assert.throws(
    () => parseLaunchOptions([], { PORT: "30141&whoami" }),
    /Port must be a non-negative integer/,
  );
});

test("supports PI_WEB_HOSTNAME without trusting the ambient system HOSTNAME", () => {
  assert.equal(
    parseLaunchOptions([], { HOSTNAME: "container-id" }).hostname,
    "127.0.0.1",
  );
  assert.equal(
    parseLaunchOptions([], { PI_WEB_HOSTNAME: "0.0.0.0" }).hostname,
    "0.0.0.0",
  );
});
