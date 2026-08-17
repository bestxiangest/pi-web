import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { wireAppProcessLifecycle, wireChildProcessLifecycle } from "../bin/process-lifecycle.js";

function createProcesses() {
  const parent = new EventEmitter();
  const child = new EventEmitter();
  const forwardedSignals = [];
  const exitCodes = [];

  child.kill = (signal) => {
    forwardedSignals.push(signal);
    return true;
  };
  parent.exit = (code) => {
    exitCodes.push(code);
  };

  return { parent, child, forwardedSignals, exitCodes };
}

function createChild() {
  const child = new EventEmitter();
  child.forwardedSignals = [];
  child.kill = (signal) => {
    child.forwardedSignals.push(signal);
    return true;
  };
  return child;
}

test("forwards the first shutdown signal and force-kills on repeated signals", () => {
  const { parent, child, forwardedSignals } = createProcesses();

  wireChildProcessLifecycle(child, parent);
  parent.emit("SIGTERM");
  parent.emit("SIGTERM");
  parent.emit("SIGINT");

  assert.deepEqual(forwardedSignals, ["SIGTERM", "SIGKILL", "SIGKILL"]);
  child.emit("exit", null, "SIGKILL");
});

test("propagates a child exit code and clears its shutdown wiring", async () => {
  const { parent, child, forwardedSignals, exitCodes } = createProcesses();
  const existingSigtermListener = () => {};
  parent.on("SIGTERM", existingSigtermListener);

  wireChildProcessLifecycle(child, parent, 10);
  assert.equal(parent.listenerCount("SIGINT"), 1);
  assert.equal(parent.listenerCount("SIGTERM"), 2);

  parent.emit("SIGTERM");
  child.emit("exit", 23, null);
  await delay(20);

  assert.deepEqual(exitCodes, [23]);
  assert.equal(parent.listenerCount("SIGINT"), 0);
  assert.deepEqual(parent.listeners("SIGTERM"), [existingSigtermListener]);

  parent.emit("SIGTERM");
  assert.deepEqual(forwardedSignals, ["SIGTERM"]);
});

test("force-kills the child when graceful shutdown times out", async () => {
  const { parent, child, forwardedSignals } = createProcesses();

  wireChildProcessLifecycle(child, parent, 10);
  parent.emit("SIGINT");
  assert.deepEqual(forwardedSignals, ["SIGINT"]);

  await delay(20);

  assert.deepEqual(forwardedSignals, ["SIGINT", "SIGKILL"]);
  child.emit("exit", null, "SIGKILL");
});

test("uses conventional exit statuses for known child signals", () => {
  for (const [signal, expectedExitCode] of [
    ["SIGTERM", 143],
    ["SIGKILL", 137],
  ]) {
    const { parent, child, exitCodes } = createProcesses();

    wireChildProcessLifecycle(child, parent);
    child.emit("exit", null, signal);

    assert.deepEqual(exitCodes, [expectedExitCode]);
  }
});

test("app exit stops the server and preserves the app exit status", () => {
  const parent = new EventEmitter();
  const server = createChild();
  const app = createChild();
  const exitCodes = [];
  parent.exit = (code) => exitCodes.push(code);

  const lifecycle = wireAppProcessLifecycle(server, parent);
  lifecycle.attachAppProcess(app);
  app.emit("exit", 0, null);

  assert.deepEqual(server.forwardedSignals, ["SIGTERM"]);
  assert.deepEqual(exitCodes, []);

  server.emit("exit", null, "SIGTERM");
  assert.deepEqual(exitCodes, [0]);
});

test("server failure stops the desktop app and preserves the server status", () => {
  const parent = new EventEmitter();
  const server = createChild();
  const app = createChild();
  const exitCodes = [];
  parent.exit = (code) => exitCodes.push(code);

  const lifecycle = wireAppProcessLifecycle(server, parent);
  lifecycle.attachAppProcess(app);
  server.emit("exit", 27, null);

  assert.deepEqual(app.forwardedSignals, ["SIGTERM"]);
  app.emit("exit", 0, null);
  assert.deepEqual(exitCodes, [27]);
});

test("desktop lifecycle forwards shutdown signals to both children", () => {
  const parent = new EventEmitter();
  const server = createChild();
  const app = createChild();
  const exitCodes = [];
  parent.exit = (code) => exitCodes.push(code);

  const lifecycle = wireAppProcessLifecycle(server, parent);
  lifecycle.attachAppProcess(app);
  parent.emit("SIGINT");

  assert.deepEqual(server.forwardedSignals, ["SIGINT"]);
  assert.deepEqual(app.forwardedSignals, ["SIGINT"]);

  server.emit("exit", null, "SIGINT");
  app.emit("exit", null, "SIGINT");
  assert.deepEqual(exitCodes, [130]);
});

test("desktop lifecycle treats an Electron spawn error as a failure", () => {
  const parent = new EventEmitter();
  const server = createChild();
  const app = createChild();
  const exitCodes = [];
  parent.exit = (code) => exitCodes.push(code);

  const lifecycle = wireAppProcessLifecycle(server, parent);
  lifecycle.attachAppProcess(app);
  app.emit("error", new Error("spawn failed"));

  assert.deepEqual(server.forwardedSignals, ["SIGTERM"]);
  server.emit("exit", null, "SIGTERM");
  assert.deepEqual(exitCodes, [1]);
});
