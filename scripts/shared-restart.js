const { spawn } = require("child_process");
const {
  rootDir,
  bridgePidFile,
  isPidAlive,
  readPidFile,
  stopSharedProcesses,
} = require("./shared-common");

function readNumberArg(name, fallback = 0) {
  const prefix = `--${name}=`;
  const value = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  const parsed = Number.parseInt(value ? value.slice(prefix.length) : "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

async function main() {
  const delayMs = readNumberArg("delay-ms", 0);
  const expectedPid = readNumberArg("expected-pid", 0);
  const bridgePid = readPidFile(bridgePidFile);
  if (!bridgePid || !isPidAlive(bridgePid)) {
    throw new Error("shared Cyberboss bridge is not running");
  }
  if (expectedPid && bridgePid !== expectedPid) {
    throw new Error(`shared Cyberboss bridge changed from pid=${expectedPid} to pid=${bridgePid}; restart cancelled`);
  }

  if (delayMs) {
    await sleep(delayMs);
  }
  await stopSharedProcesses();

  const child = spawn(process.execPath, ["./scripts/shared-start.js"], {
    cwd: rootDir,
    env: process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exit(1);
});
