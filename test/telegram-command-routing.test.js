const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const path = require("path");

const { createTelegramChannelAdapter } = require("../src/adapters/channel/telegram");
const { CyberbossApp } = require("../src/core/app");

function createAdapter() {
  const stateDir = path.join(os.tmpdir(), "cyberboss-telegram-command-test");
  return createTelegramChannelAdapter({
    telegramBotToken: "test-token",
    telegramAllowedUserIds: ["8896895476"],
    telegramAllowedGroupIds: [],
    telegramPrimaryWeixinUserId: "wx-user-1",
    telegramOffsetFile: path.join(stateDir, "offset.json"),
    telegramGroupContextFile: path.join(stateDir, "group-context.jsonl"),
    telegramGroupDiscoveryFile: path.join(stateDir, "group-discovery.jsonl"),
    telegramTtsEnabled: false,
    workspaceId: "default",
  }, {
    accountId: () => "account-1",
  });
}

test("Telegram keeps raw command text alongside the wrapped runtime message", () => {
  const normalized = createAdapter().normalizeIncomingMessage({
    message: {
      message_id: 1690,
      date: 1787722400,
      text: "/yes",
      chat: { id: 8896895476, type: "private" },
      from: { id: 8896895476, username: "" },
    },
  });

  assert.equal(normalized.commandText, "/yes");
  assert.match(normalized.text, /<channel source="telegram"/);
});

test("Telegram slash commands dispatch before a blocked runtime turn", async () => {
  let dispatchedCommand = null;
  let preparedForRuntime = false;
  const sessionStore = {
    buildBindingKey() {
      return "binding-1";
    },
    setLastReplyTarget() {},
  };
  const appLike = {
    runtimeAdapter: {
      getSessionStore() {
        return sessionStore;
      },
    },
    streamDelivery: {
      setReplyTarget() {},
    },
    async dispatchChannelCommand(normalized, command) {
      dispatchedCommand = { normalized, command };
    },
    async prepareIncomingMessageForRuntime() {
      preparedForRuntime = true;
      return null;
    },
  };

  await CyberbossApp.prototype.handlePreparedMessage.call(appLike, {
    workspaceId: "default",
    accountId: "account-1",
    senderId: "wx-user-1",
    contextToken: "telegram:8896895476",
    provider: "telegram",
    text: "<channel source=\"telegram\">/yes</channel>",
    commandText: "/yes",
  }, { allowCommands: true });

  assert.equal(dispatchedCommand.command.name, "yes");
  assert.equal(preparedForRuntime, false);
});
