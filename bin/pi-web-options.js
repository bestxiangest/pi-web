"use strict";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { parseArgs } = require("util");

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

function isEnabled(value) {
  return typeof value === "string" && TRUE_VALUES.has(value.trim().toLowerCase());
}

function normalizePort(value) {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new Error("Port must be a non-negative integer.");
  }

  const port = Number(value);
  if (!Number.isSafeInteger(port) || port > 65535) {
    throw new Error("Port must be between 0 and 65535.");
  }

  return String(port);
}

function parseLaunchOptions(args = process.argv.slice(2), env = process.env) {
  const { values: cliArgs, positionals } = parseArgs({
    args,
    options: {
      port:      { type: "string", short: "p" },
      hostname:  { type: "string", short: "H" },
      "no-open": { type: "boolean" },
    },
    strict: false,
  });

  if (positionals.length > 1 || (positionals.length === 1 && positionals[0] !== "app")) {
    throw new Error(`Unknown command: ${positionals.join(" ")}`);
  }

  const mode = positionals[0] === "app" ? "app" : "web";
  if (mode === "app" && cliArgs["no-open"]) {
    throw new Error("The --no-open option cannot be used with the app command.");
  }

  return {
    mode,
    port: normalizePort(cliArgs.port ?? env.PORT ?? "30141"),
    hostname: cliArgs.hostname ?? env.PI_WEB_HOSTNAME ?? "127.0.0.1",
    openBrowser: mode === "app" || (!cliArgs["no-open"] && !isEnabled(env.PI_WEB_NO_OPEN)),
  };
}

module.exports = { parseLaunchOptions };
