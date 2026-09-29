const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { SessionStore } = require("../src/adapters/runtime/codex/session-store");

test("session store collapses Windows slash variants into the active thread", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-workspace-root-"));
  const filePath = path.join(dir, "sessions.json");
  fs.writeFileSync(filePath, JSON.stringify({
    bindings: {
      "binding-1": {
        activeWorkspaceRoot: "C:/cyberboss-lintuan-V",
        threadIdByWorkspaceRoot: {
          "C:\\cyberboss-lintuan-V": "old-thread",
          "C:/cyberboss-lintuan-V": "telegram-thread",
        },
        threadIdByWorkspaceRootByRuntime: {
          codex: {
            "C:\\cyberboss-lintuan-V": "old-thread",
            "C:/cyberboss-lintuan-V": "telegram-thread",
          },
        },
      },
    },
  }), "utf8");

  const store = new SessionStore({ filePath, runtimeId: "codex" });

  assert.equal(store.getActiveWorkspaceRoot("binding-1"), "C:\\cyberboss-lintuan-V");
  assert.equal(store.getThreadIdForWorkspace("binding-1", "C:\\cyberboss-lintuan-V"), "telegram-thread");
  assert.equal(store.getThreadIdForWorkspace("binding-1", "C:/cyberboss-lintuan-V"), "telegram-thread");
  assert.deepEqual(store.listWorkspaceRoots("binding-1"), ["C:\\cyberboss-lintuan-V"]);
});

test("new session writes use one canonical Windows workspace key", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-workspace-root-"));
  const store = new SessionStore({ filePath: path.join(dir, "sessions.json"), runtimeId: "codex" });

  store.setThreadIdForWorkspace("binding-1", "C:/cyberboss-lintuan-V", "thread-1");
  store.setThreadIdForWorkspace("binding-1", "C:\\cyberboss-lintuan-V", "thread-2");

  assert.deepEqual(store.listWorkspaceRoots("binding-1"), ["C:\\cyberboss-lintuan-V"]);
  assert.equal(store.getThreadIdForWorkspace("binding-1", "C:/cyberboss-lintuan-V"), "thread-2");
});
