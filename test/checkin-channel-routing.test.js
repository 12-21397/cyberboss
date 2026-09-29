const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { SessionStore } = require("../src/adapters/runtime/codex/session-store");
const { CyberbossApp } = require("../src/core/app");
const { SystemMessageDispatcher } = require("../src/core/system-message-dispatcher");
const { SystemMessageQueueStore } = require("../src/core/system-message-queue-store");

test("session store persists the last active chat route", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-checkin-route-"));
  const filePath = path.join(dir, "sessions.json");
  const store = new SessionStore({ filePath });

  store.setLastReplyTarget("binding-1", {
    userId: "wx-user-1",
    contextToken: "telegram:8896895476",
    provider: "telegram",
  });

  const reloaded = new SessionStore({ filePath });
  assert.deepEqual(reloaded.getLastReplyTarget("binding-1"), {
    userId: "wx-user-1",
    contextToken: "telegram:8896895476",
    provider: "telegram",
    updatedAt: reloaded.getBinding("binding-1").lastReplyTarget.updatedAt,
  });

  reloaded.setLastReplyTarget("binding-1", {
    userId: "wx-user-1",
    contextToken: "wx-context-2",
    provider: "weixin",
  });
  assert.equal(reloaded.getLastReplyTarget("binding-1").provider, "weixin");
});

test("random check-in queue records retain last-active routing mode", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-checkin-queue-"));
  const store = new SystemMessageQueueStore({ filePath: path.join(dir, "queue.json") });
  const base = {
    accountId: "account-1",
    senderId: "wx-user-1",
    workspaceRoot: "C:\\workspace",
    text: "宝宝 comes to mind again.",
    createdAt: "2026-08-26T04:00:00.000Z",
  };

  store.enqueue({ id: "checkin-1", ...base, deliveryMode: "last_active" });
  store.enqueue({
    id: "reminder-1",
    ...base,
    deliveryMode: "unsupported",
    contextToken: "qqbot:c2c:qq-user-1",
  });

  const [checkin, reminder] = store.drainForAccount("account-1");
  assert.equal(checkin.deliveryMode, "last_active");
  assert.equal("deliveryMode" in reminder, false);
  assert.equal(reminder.contextToken, "qqbot:c2c:qq-user-1");
});

test("check-ins follow Telegram while other system messages stay on WeChat", () => {
  const appLike = {
    channelAdapter: {
      getKnownContextTokens() {
        return { "wx-user-1": "wx-context-current" };
      },
    },
  };
  const sessionStore = {
    getLastReplyTarget() {
      return {
        userId: "wx-user-1",
        contextToken: "telegram:8896895476",
        provider: "telegram",
      };
    },
  };
  const checkin = CyberbossApp.prototype.resolveSystemMessageDeliveryTarget.call(appLike, {
    message: { senderId: "wx-user-1", deliveryMode: "last_active" },
    bindingKey: "binding-1",
    sessionStore,
  });
  const reminder = CyberbossApp.prototype.resolveSystemMessageDeliveryTarget.call(appLike, {
    message: { senderId: "wx-user-1" },
    bindingKey: "binding-1",
    sessionStore,
  });

  assert.deepEqual(checkin, {
    userId: "wx-user-1",
    contextToken: "telegram:8896895476",
    provider: "telegram",
  });
  assert.deepEqual(reminder, {
    userId: "wx-user-1",
    contextToken: "wx-context-current",
    provider: "weixin",
  });
});

test("check-ins follow QQ when QQ was the last active chat", () => {
  const appLike = {
    channelAdapter: {
      getKnownContextTokens() {
        return { "wx-user-1": "wx-context-current" };
      },
    },
  };
  const target = CyberbossApp.prototype.resolveSystemMessageDeliveryTarget.call(appLike, {
    message: { senderId: "wx-user-1", deliveryMode: "last_active" },
    bindingKey: "binding-1",
    sessionStore: {
      getLastReplyTarget() {
        return {
          userId: "wx-user-1",
          contextToken: "qqbot:c2c:qq-user-1",
          provider: "qqbot",
        };
      },
    },
  });

  assert.deepEqual(target, {
    userId: "wx-user-1",
    contextToken: "qqbot:c2c:qq-user-1",
    provider: "qqbot",
  });
});

test("due reminders keep the QQ route captured when they were created", () => {
  const appLike = {
    channelAdapter: {
      getKnownContextTokens() {
        return { "wx-user-1": "wx-context-current" };
      },
    },
  };
  const target = CyberbossApp.prototype.resolveSystemMessageDeliveryTarget.call(appLike, {
    message: {
      senderId: "wx-user-1",
      contextToken: "qqbot:c2c:qq-user-1",
    },
    bindingKey: "binding-1",
    sessionStore: null,
  });

  assert.deepEqual(target, {
    userId: "wx-user-1",
    contextToken: "qqbot:c2c:qq-user-1",
    provider: "qqbot",
  });
});

test("approval prompts resolve to QQ when QQ owns the shared binding", () => {
  const appLike = {
    channelAdapter: {
      getKnownContextTokens() {
        return { "wx-user-1": "wx-context-current" };
      },
    },
    runtimeAdapter: {
      getSessionStore() {
        return {
          getBinding() {
            return { senderId: "wx-user-1" };
          },
          getLastReplyTarget() {
            return {
              userId: "wx-user-1",
              contextToken: "qqbot:c2c:qq-user-1",
              provider: "qqbot",
            };
          },
        };
      },
    },
  };

  assert.deepEqual(CyberbossApp.prototype.resolveReplyTargetForBinding.call(appLike, "binding-1"), {
    userId: "wx-user-1",
    contextToken: "qqbot:c2c:qq-user-1",
    provider: "qqbot",
  });
});

test("approval prompts refresh the current WeChat token after returning to WeChat", () => {
  const appLike = {
    channelAdapter: {
      getKnownContextTokens() {
        return { "wx-user-1": "wx-context-current" };
      },
    },
    runtimeAdapter: {
      getSessionStore() {
        return {
          getBinding() {
            return { senderId: "wx-user-1" };
          },
          getLastReplyTarget() {
            return {
              userId: "wx-user-1",
              contextToken: "wx-context-old",
              provider: "weixin",
            };
          },
        };
      },
    },
  };

  assert.equal(
    CyberbossApp.prototype.resolveReplyTargetForBinding.call(appLike, "binding-1").contextToken,
    "wx-context-current"
  );
});

test("returning to WeChat refreshes its context token before a check-in", () => {
  const appLike = {
    channelAdapter: {
      getKnownContextTokens() {
        return { "wx-user-1": "wx-context-current" };
      },
    },
  };
  const target = CyberbossApp.prototype.resolveSystemMessageDeliveryTarget.call(appLike, {
    message: { senderId: "wx-user-1", deliveryMode: "last_active" },
    bindingKey: "binding-1",
    sessionStore: {
      getLastReplyTarget() {
        return {
          userId: "wx-user-1",
          contextToken: "wx-context-old",
          provider: "weixin",
        };
      },
    },
  });

  assert.equal(target.provider, "weixin");
  assert.equal(target.contextToken, "wx-context-current");
});

test("system dispatcher keeps system parsing while targeting Telegram", () => {
  const dispatcher = new SystemMessageDispatcher({
    queueStore: {},
    config: { workspaceId: "workspace-1", workspaceRoot: "C:\\workspace" },
    accountId: "account-1",
  });
  const prepared = dispatcher.buildPreparedMessage({
    id: "checkin-1",
    senderId: "wx-user-1",
    text: "宝宝 comes to mind again.",
    createdAt: "2026-08-26T04:00:00.000Z",
  }, {
    userId: "wx-user-1",
    contextToken: "telegram:8896895476",
    provider: "telegram",
  });

  assert.equal(prepared.provider, "system");
  assert.equal(prepared.contextToken, "telegram:8896895476");
  assert.match(prepared.text, /one short natural chat message/);
});
