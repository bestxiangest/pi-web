"use strict";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const os = require("node:os");

const forwardedSignals = ["SIGINT", "SIGTERM"];
const shutdownTimeoutMs = 5_000;

function getSignalExitCode(signal) {
  const signalNumber = signal ? os.constants.signals[signal] : undefined;
  return typeof signalNumber === "number" ? 128 + signalNumber : 1;
}

function wireChildProcessLifecycle(child, parentProcess = process, timeoutMs = shutdownTimeoutMs) {
  const signalHandlers = new Map();
  let shutdownTimer;

  const forceKill = () => child.kill("SIGKILL");

  for (const signal of forwardedSignals) {
    const handler = () => {
      if (shutdownTimer) {
        forceKill();
        return;
      }

      shutdownTimer = setTimeout(forceKill, timeoutMs);
      shutdownTimer.unref();
      child.kill(signal);
    };
    signalHandlers.set(signal, handler);
    parentProcess.on(signal, handler);
  }

  child.once("exit", (code, signal) => {
    if (shutdownTimer) clearTimeout(shutdownTimer);

    for (const [forwardedSignal, handler] of signalHandlers) {
      parentProcess.removeListener(forwardedSignal, handler);
    }

    parentProcess.exit(code ?? getSignalExitCode(signal));
  });
}

function wireAppProcessLifecycle(serverChild, parentProcess = process, timeoutMs = shutdownTimeoutMs) {
  const childStates = new Map();
  const signalHandlers = new Map();
  let shutdownStatus;
  let shutdownTimer;
  let parentExited = false;

  const killRunningChildren = (signal) => {
    for (const [child, exited] of childStates) {
      if (!exited) child.kill(signal);
    }
  };

  const finishIfReady = () => {
    if (parentExited || !shutdownStatus || [...childStates.values()].some((exited) => !exited)) {
      return;
    }
    parentExited = true;
    if (shutdownTimer) clearTimeout(shutdownTimer);
    for (const [signal, handler] of signalHandlers) {
      parentProcess.removeListener(signal, handler);
    }
    parentProcess.exit(shutdownStatus.code ?? getSignalExitCode(shutdownStatus.signal));
  };

  const beginShutdown = (status, sourceChild, signal = "SIGTERM") => {
    shutdownStatus ??= status;
    for (const [child, exited] of childStates) {
      if (!exited && child !== sourceChild) child.kill(signal);
    }
    if (!shutdownTimer && [...childStates.values()].some((exited) => !exited)) {
      shutdownTimer = setTimeout(() => killRunningChildren("SIGKILL"), timeoutMs);
      shutdownTimer.unref();
    }
    finishIfReady();
  };

  const watchChild = (child) => {
    childStates.set(child, false);
    let handled = false;
    const onExit = (code, signal) => {
      if (handled) return;
      handled = true;
      childStates.set(child, true);
      beginShutdown({ code, signal }, child);
    };
    child.once("error", () => onExit(1, null));
    child.once("exit", onExit);
    if (shutdownStatus) child.kill("SIGTERM");
  };

  watchChild(serverChild);

  for (const signal of forwardedSignals) {
    const handler = () => {
      if (shutdownStatus) {
        killRunningChildren("SIGKILL");
        return;
      }
      beginShutdown({ code: null, signal }, null, signal);
    };
    signalHandlers.set(signal, handler);
    parentProcess.on(signal, handler);
  }

  return {
    attachAppProcess: watchChild,
    shutdown(code = 0) {
      beginShutdown({ code, signal: null }, null);
    },
  };
}

module.exports = { wireAppProcessLifecycle, wireChildProcessLifecycle };
