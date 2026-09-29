const test = require("node:test");
const assert = require("node:assert/strict");

const { findBoundThread } = require("../scripts/shared-common");

test("shared open follows the active Telegram thread across Windows slash variants", () => {
  const binding = {
    activeWorkspaceRoot: "C:/cyberboss-lintuan-V",
    threadIdByWorkspaceRootByRuntime: {
      codex: {
        "C:\\cyberboss-lintuan-V": "old-wechat-thread",
        "C:/cyberboss-lintuan-V": "active-telegram-thread",
      },
    },
  };

  assert.deepEqual(findBoundThread([binding], "C:\\cyberboss-lintuan-V", "codex"), {
    threadId: "active-telegram-thread",
    workspaceRoot: "C:/cyberboss-lintuan-V",
  });
});

test("shared open still uses an exact thread when it is not the active workspace", () => {
  const binding = {
    activeWorkspaceRoot: "D:\\another-project",
    threadIdByWorkspaceRootByRuntime: {
      codex: {
        "C:\\cyberboss-lintuan-V": "requested-thread",
        "D:\\another-project": "active-other-thread",
      },
    },
  };

  assert.deepEqual(findBoundThread([binding], "C:\\cyberboss-lintuan-V", "codex"), {
    threadId: "requested-thread",
    workspaceRoot: "C:\\cyberboss-lintuan-V",
  });
});
