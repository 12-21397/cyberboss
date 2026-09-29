const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const {
  buildCodexHttpMcpConfigArgs,
  buildCodexMcpConfigArgs,
  resolveCodexProjectToolMcpServerConfig,
} = require("../src/adapters/runtime/codex/mcp-config");

try {
  require("dotenv").config({ path: path.join(process.cwd(), ".env") });
} catch {
  // ignore
}

try {
  require("dotenv").config({ path: path.join(os.homedir(), ".cyberboss", ".env") });
} catch {
  // ignore
}

const rootDir = path.resolve(__dirname, "..");
const port = String(process.env.CYBERBOSS_SHARED_PORT || "8765");
const listenUrl = `ws://127.0.0.1:${port}`;
const stateDir = process.env.CYBERBOSS_STATE_DIR || path.join(os.homedir(), ".cyberboss");
const logDir = path.join(stateDir, "logs");
const appServerPidFile = path.join(logDir, "shared-app-server.pid");
const bridgePidFile = path.join(logDir, "shared-wechat.pid");
const appServerLogFile = path.join(logDir, "shared-app-server.log");
const accountsDir = path.join(stateDir, "accounts");
const sessionFile = process.env.CYBERBOSS_SESSIONS_FILE || path.join(stateDir, "sessions.json");

function ensureLogDir() {
  fs.mkdirSync(logDir, { recursive: true });
}

function isPidAlive(pid) {
  const numeric = Number(pid);
  if (!Number.isInteger(numeric) || numeric <= 0) {
    return false;
  }
  try {
    process.kill(numeric, 0);
    return true;
  } catch {
    return false;
  }
}

function getListeningPid() {
  if (process.platform !== "win32") {
    return 0;
  }
  const numericPort = Number.parseInt(port, 10);
  if (!Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65535) {
    return 0;
  }
  const result = spawnSync("netstat.exe", ["-ano", "-p", "TCP"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) {
    return 0;
  }
  const pid = String(result.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .filter((fields) => fields.length >= 5 && fields[0].toUpperCase() === "TCP")
    .find((fields) => (
      fields[1] === `127.0.0.1:${numericPort}`
      && fields[2].endsWith(":0")
    ))?.at(-1);
  const numericPid = Number.parseInt(pid || "", 10);
  return Number.isInteger(numericPid) && numericPid > 0 ? numericPid : 0;
}

function getWindowsProcessCommandLine(pid) {
  if (process.platform !== "win32" || !isPidAlive(pid)) {
    return "";
  }
  const script = [
    `$process = Get-CimInstance Win32_Process -Filter \"ProcessId = ${Number(pid)}\" -ErrorAction SilentlyContinue`,
    "$process.CommandLine",
  ].join("; ");
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", windowsHide: true }
  );
  return result.status === 0 ? String(result.stdout || "").trim() : "";
}

function isExpectedBridgeProcess(pid) {
  if (process.platform !== "win32") {
    return isPidAlive(pid);
  }
  const commandLine = getWindowsProcessCommandLine(pid).toLowerCase();
  return commandLine.includes("cyberboss.js")
    && commandLine.includes(" start")
    && commandLine.includes("--checkin");
}

function isExpectedAppServerProcess(pid, listenerPid = 0) {
  if (!isPidAlive(pid)) {
    return false;
  }
  if (pid === listenerPid && listenerPid > 0) {
    return true;
  }
  if (process.platform !== "win32") {
    return true;
  }
  const commandLine = getWindowsProcessCommandLine(pid).toLowerCase();
  return commandLine.includes("app-server")
    && commandLine.includes(listenUrl.toLowerCase());
}

function killProcessTree(pid, { force = false } = {}) {
  if (!isPidAlive(pid)) {
    return false;
  }
  if (process.platform === "win32") {
    const args = ["/pid", String(pid), "/t"];
    if (force) {
      args.push("/f");
    }
    const result = spawnSync("taskkill.exe", args, {
      encoding: "utf8",
      windowsHide: true,
    });
    if (result.status !== 0 && isPidAlive(pid)) {
      if (force) {
        throw new Error(`failed to force-stop process tree pid=${pid}`);
      }
      return false;
    }
    return true;
  }
  try {
    process.kill(-Number(pid), force ? "SIGKILL" : "SIGTERM");
  } catch (error) {
    if (error?.code !== "ESRCH") {
      throw error;
    }
  }
  return true;
}

async function waitForExit(pid, { attempts = 20, delayMs = 250 } = {}) {
  for (let index = 0; index < attempts; index += 1) {
    if (!isPidAlive(pid)) {
      return true;
    }
    await sleep(delayMs);
  }
  return !isPidAlive(pid);
}

async function stopVerifiedProcessTree(pid, validator) {
  if (!pid || !isPidAlive(pid)) {
    return false;
  }
  if (!validator(pid)) {
    throw new Error(`refusing to stop unexpected process pid=${pid}`);
  }
  killProcessTree(pid);
  if (await waitForExit(pid, { attempts: 12, delayMs: 250 })) {
    return true;
  }
  killProcessTree(pid, { force: true });
  if (!(await waitForExit(pid, { attempts: 12, delayMs: 250 }))) {
    throw new Error(`process tree pid=${pid} did not stop`);
  }
  return true;
}

async function stopSharedProcesses() {
  const stopped = [];
  const bridgePid = readPidFile(bridgePidFile);
  if (bridgePid && isPidAlive(bridgePid)) {
    if (isExpectedBridgeProcess(bridgePid)
      && await stopVerifiedProcessTree(bridgePid, isExpectedBridgeProcess)) {
      stopped.push({ name: "bridge", pid: bridgePid });
    }
  }
  fs.rmSync(bridgePidFile, { force: true });

  const storedAppServerPid = readPidFile(appServerPidFile);
  const listenerPid = getListeningPid();
  const candidates = [...new Set([storedAppServerPid, listenerPid].filter(Boolean))];
  for (const pid of candidates) {
    if (!isPidAlive(pid)) {
      continue;
    }
    const validator = (candidate) => isExpectedAppServerProcess(candidate, listenerPid);
    if (validator(pid) && await stopVerifiedProcessTree(pid, validator)) {
      stopped.push({ name: "app-server", pid });
    }
  }
  fs.rmSync(appServerPidFile, { force: true });
  return stopped;
}

function readPidFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8").trim();
    return raw ? Number.parseInt(raw, 10) : 0;
  } catch {
    return 0;
  }
}

function writePidFile(filePath, pid) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${pid}\n`, "utf8");
}

function removePidFileIfMatches(filePath, pid) {
  const current = readPidFile(filePath);
  if (current && current === pid) {
    fs.rmSync(filePath, { force: true });
  }
}

function checkReadyz() {
  return new Promise((resolve) => {
    const req = http.get(
      {
        hostname: "127.0.0.1",
        port: Number(port),
        path: "/readyz",
        timeout: 500,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode >= 200 && res.statusCode < 300);
      }
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitForReadyz({ attempts = 10, delayMs = 300 } = {}) {
  for (let index = 0; index < attempts; index += 1) {
    if (await checkReadyz()) {
      return true;
    }
    await sleep(delayMs);
  }
  return false;
}

function openLogFile(filePath) {
  return fs.openSync(filePath, "a");
}

function spawnDetachedCommand(command, args, { logFile, cwd = rootDir, env = {} } = {}) {
  const stdoutFd = openLogFile(logFile);
  const stderrFd = openLogFile(logFile);
  const isWin = process.platform === "win32";

  // On Windows, use cmd.exe /c explicitly, passing each argument as an
  // independent array element. Node's spawn (shell: false) builds the
  // lpCommandLine via CreateProcess which properly quotes each arg 鈥?
  // this avoids the double-quote stripping that happens with shell: true.
  const spawnCommand = isWin ? "cmd.exe" : command;
  const spawnArgs = isWin ? ["/d", "/c", command, ...args] : args;
  const spawnOpts = {
    cwd,
    env: { ...process.env, ...env },
    detached: true,
    stdio: ["ignore", stdoutFd, stderrFd],
    shell: false,
    windowsHide: true,
  };

  const child = spawn(spawnCommand, spawnArgs, spawnOpts);
  child.unref();
  return child.pid;
}

async function ensureSharedAppServer() {
  if (process.env.CYBERBOSS_RUNTIME && process.env.CYBERBOSS_RUNTIME !== "codex") {
    return { pid: 0, status: "skipped" };
  }

  ensureLogDir();
  const pidFromFile = readPidFile(appServerPidFile);
  if (pidFromFile && isPidAlive(pidFromFile) && (await checkReadyz())) {
    const listenerPid = getListeningPid();
    const pid = listenerPid || pidFromFile;
    writePidFile(appServerPidFile, pid);
    return { pid, status: "already_running" };
  }

  if (await checkReadyz()) {
    const listenerPid = getListeningPid();
    if (listenerPid) {
      writePidFile(appServerPidFile, listenerPid);
    }
    return { pid: listenerPid || pidFromFile || 0, status: "already_running_unknown_pid" };
  }

  const env = {
    CYBERBOSS_STATE_DIR: stateDir,
    TIMELINE_FOR_AGENT_STATE_DIR: stateDir,
  };
  if (!process.env.TIMELINE_FOR_AGENT_CHROME_PATH) {
    env.TIMELINE_FOR_AGENT_CHROME_PATH =
      process.env.CYBERBOSS_SCREENSHOT_CHROME_PATH
      || (process.platform === "darwin"
        ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
        : "");
  }

  const command = process.env.CYBERBOSS_CODEX_COMMAND || "codex";
  const mcpConfigArgs = buildCodexMcpConfigArgs(resolveCodexProjectToolMcpServerConfig({
    cyberbossHome: process.env.CYBERBOSS_HOME || rootDir,
  })).concat(buildCodexHttpMcpConfigArgs({
    name: "ombre_brain",
    url: process.env.CYBERBOSS_OMBRE_MCP_URL,
  })).concat(buildCodexHttpMcpConfigArgs({
    name: "galatea-garden",
    url: process.env.CYBERBOSS_GALATEA_GARDEN_MCP_URL,
    bearerTokenEnvVar: "GALATEA_GARDEN_MCP_TOKEN",
  }));
  const pid = spawnDetachedCommand(command, [...mcpConfigArgs, "app-server", "--listen", listenUrl], {
    logFile: appServerLogFile,
    env,
  });
  writePidFile(appServerPidFile, pid);

  const ready = await waitForReadyz();
  if (!ready) {
    throw new Error(`failed to start shared app-server; check ${appServerLogFile}`);
  }

  const listenerPid = getListeningPid();
  const resolvedPid = listenerPid || pid;
  writePidFile(appServerPidFile, resolvedPid);
  return { pid: resolvedPid, status: "started" };
}

function ensureBridgeNotRunning() {
  const pidFromFile = readPidFile(bridgePidFile);
  if (pidFromFile && isPidAlive(pidFromFile)) {
    return pidFromFile;
  }
  if (pidFromFile) {
    fs.rmSync(bridgePidFile, { force: true });
  }
  return 0;
}

function resolveCurrentAccountId() {
  if (!fs.existsSync(accountsDir)) {
    return "";
  }
  const entries = fs.readdirSync(accountsDir)
    .filter((name) => name.endsWith(".json") && !name.endsWith(".context-tokens.json"))
    .map((name) => {
      const fullPath = path.join(accountsDir, name);
      try {
        const parsed = JSON.parse(fs.readFileSync(fullPath, "utf8"));
        return {
          accountId: normalizeText(parsed?.accountId),
          savedAt: parseTimestamp(parsed?.savedAt),
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .filter((entry) => entry.accountId);
  entries.sort((left, right) => right.savedAt - left.savedAt);
  return entries[0]?.accountId || "";
}

function resolveBoundThread(workspaceRoot) {
  if (!fs.existsSync(sessionFile)) {
    throw new Error(`session file not found: ${sessionFile}`);
  }
  const runtimeId = normalizeText(process.env.CYBERBOSS_RUNTIME || "codex");
  const data = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
  const currentAccountId = resolveCurrentAccountId();
  const bindings = Object.values(data.bindings || {})
    .filter((binding) => !currentAccountId || normalizeText(binding?.accountId) === currentAccountId)
    .sort((left, right) => parseTimestamp(right?.updatedAt) - parseTimestamp(left?.updatedAt));

  const resolved = findBoundThread(bindings, workspaceRoot, runtimeId);
  if (resolved) {
    return resolved;
  }

  throw new Error(`no bound WeChat thread found for workspace: ${workspaceRoot}`);
}

function findBoundThread(bindings, workspaceRoot, runtimeId = "") {
  const normalizedWorkspaceRoot = normalizeText(workspaceRoot);
  const comparableWorkspaceRoot = normalizeWorkspacePath(normalizedWorkspaceRoot);
  const activeMatch = bindings.find((binding) => {
    const activeWorkspaceRoot = normalizeText(binding?.activeWorkspaceRoot);
    return activeWorkspaceRoot
      && normalizeWorkspacePath(activeWorkspaceRoot) === comparableWorkspaceRoot
      && getThreadId(binding, activeWorkspaceRoot, runtimeId);
  });
  if (activeMatch) {
    const activeWorkspaceRoot = normalizeText(activeMatch.activeWorkspaceRoot);
    return {
      threadId: getThreadId(activeMatch, activeWorkspaceRoot, runtimeId),
      workspaceRoot: activeWorkspaceRoot,
    };
  }

  const exact = bindings.find((binding) => getThreadId(binding, normalizedWorkspaceRoot, runtimeId));
  if (exact) {
    return {
      threadId: getThreadId(exact, normalizedWorkspaceRoot, runtimeId),
      workspaceRoot: normalizedWorkspaceRoot,
    };
  }

  for (const binding of bindings) {
    const threadMap = getThreadMapForRuntime(binding, runtimeId);
    const equivalentWorkspaceRoot = Object.keys(threadMap)
      .find((candidate) => normalizeWorkspacePath(candidate) === comparableWorkspaceRoot);
    if (equivalentWorkspaceRoot) {
      return {
        threadId: normalizeText(threadMap[equivalentWorkspaceRoot]),
        workspaceRoot: equivalentWorkspaceRoot,
      };
    }
  }

  const active = bindings.find((binding) => {
    const activeWorkspaceRoot = normalizeText(binding?.activeWorkspaceRoot);
    return activeWorkspaceRoot && getThreadId(binding, activeWorkspaceRoot, runtimeId);
  });
  if (!active) {
    return null;
  }
  const activeWorkspaceRoot = normalizeText(active.activeWorkspaceRoot);
  return {
    threadId: getThreadId(active, activeWorkspaceRoot, runtimeId),
    workspaceRoot: activeWorkspaceRoot,
  };
}

function getThreadId(binding, workspaceRoot, runtimeId = "") {
  if (!workspaceRoot) {
    return "";
  }
  const map = getThreadMapForRuntime(binding, runtimeId);
  return normalizeText(map[workspaceRoot]);
}

function getThreadMapForRuntime(binding, runtimeId) {
  const normalizedRuntimeId = normalizeText(runtimeId);
  const runtimeMap = binding && typeof binding.threadIdByWorkspaceRootByRuntime === "object"
    ? binding.threadIdByWorkspaceRootByRuntime
    : {};
  const scoped = runtimeMap[normalizedRuntimeId];
  return scoped && typeof scoped === "object" ? scoped : {};
}

function parseTimestamp(value) {
  const parsed = Date.parse(normalizeText(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeWorkspacePath(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return "";
  }
  const resolved = path.resolve(normalized);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  rootDir,
  port,
  listenUrl,
  stateDir,
  logDir,
  appServerPidFile,
  bridgePidFile,
  appServerLogFile,
  ensureLogDir,
  isPidAlive,
  getListeningPid,
  readPidFile,
  writePidFile,
  removePidFileIfMatches,
  ensureSharedAppServer,
  ensureBridgeNotRunning,
  stopSharedProcesses,
  resolveBoundThread,
  findBoundThread,
};
