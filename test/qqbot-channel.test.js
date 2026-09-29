const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  buildQqbotTextDelivery,
  createQqbotChannelAdapter,
  normalizeQqbotQuote,
  resolveReplyTarget,
  splitText,
} = require("../src/adapters/channel/qqbot");
const { SessionStore } = require("../src/adapters/runtime/codex/session-store");
const { resolveCurrentChatContextToken } = require("../src/services/channel-file-service");

class FakeBot extends EventEmitter {
  constructor() {
    super();
    this.sentText = [];
    this.typing = [];
    this.sentVoice = [];
    this.sentMedia = [];
  }

  async start() {}

  async sendText(target, text) {
    this.sentText.push({ target, text });
  }

  async sendTyping(target) {
    this.typing.push(target);
  }

  async sendVoice(target, source) {
    this.sentVoice.push({ target, source });
  }

  async sendMedia(options) {
    this.sentMedia.push(options);
  }
}

function makeAdapter(overrides = {}, fakeBot = new FakeBot(), options = {}) {
  const config = {
    qqbotAppId: "app-id",
    qqbotAppSecret: "app-secret",
    qqbotAllowedUserIds: ["qq-user"],
    qqbotAllowedGroupIds: ["qq-group"],
    qqbotPrimaryWeixinUserId: "weixin-user",
    workspaceId: "default",
    ...overrides,
  };
  return {
    adapter: createQqbotChannelAdapter(config, {
      accountId: () => "weixin-account",
      getMinChunkChars: () => 2,
      loadSdk: async () => ({ MediaFileType: { FILE: "file", IMAGE: "image" } }),
      createBot: async () => fakeBot,
      ...options,
    }),
    fakeBot,
  };
}

test("QQ private chat maps to the existing Weixin runtime binding", () => {
  const { adapter } = makeAdapter();
  const normalized = adapter.normalizeIncomingMessage({
    message: {
      content: "继续刚才的话题",
      kind: "c2c",
      senderId: "qq-user",
      senderName: "QQ User",
      messageId: "msg-1",
      timestamp: "2026-09-02T08:00:00.000Z",
      replyTarget: { scope: "c2c", targetId: "qq-user" },
    },
  });

  assert.equal(normalized.provider, "qqbot");
  assert.equal(normalized.accountId, "weixin-account");
  assert.equal(normalized.senderId, "weixin-user");
  assert.equal(normalized.contextToken, "qqbot:c2c:qq-user");
  assert.match(normalized.text, /继续刚才的话题/);
});

test("QQ group chat keeps a distinct reply target while sharing the runtime sender", () => {
  const { adapter } = makeAdapter();
  const normalized = adapter.normalizeIncomingMessage({
    message: {
      content: "群里继续",
      kind: "group",
      senderId: "group-member",
      senderName: "Member",
      groupOpenid: "qq-group",
      messageId: "msg-2",
      timestamp: "2026-09-02T08:00:00.000Z",
      replyTarget: { scope: "group", targetId: "qq-group" },
    },
  });

  assert.equal(normalized.senderId, "weixin-user");
  assert.equal(normalized.contextToken, "qqbot:group:qq-group");
});

test("QQ accepts attachment-only images and files for the shared inbound pipeline", () => {
  const { adapter } = makeAdapter();
  const normalized = adapter.normalizeIncomingMessage({
    message: {
      content: "",
      kind: "c2c",
      senderId: "qq-user",
      messageId: "msg-media",
      timestamp: "2026-09-03T02:02:00.000Z",
      replyTarget: { scope: "c2c", targetId: "qq-user" },
      attachments: [
        {
          content_type: "image/gif",
          url: "https://qq.example/sticker.gif",
          filename: "sticker.gif",
          size: 1234,
        },
        {
          content_type: "application/pdf",
          url: "https://qq.example/report.pdf",
          filename: "report.pdf",
        },
      ],
    },
  });

  assert.equal(normalized.attachments.length, 2);
  assert.deepEqual(normalized.attachments[0], {
    kind: "image",
    index: 0,
    fileName: "sticker.gif",
    sizeBytes: 1234,
    directUrls: ["https://qq.example/sticker.gif"],
    mediaRef: { encryptType: 0 },
    rawItem: {
      content_type: "image/gif",
      url: "https://qq.example/sticker.gif",
      filename: "sticker.gif",
      size: 1234,
    },
  });
  assert.equal(normalized.attachments[1].kind, "file");
  assert.match(normalized.text, /channel source="qqbot"/);
});

test("QQ exposes a quoted sentence in the shared runtime prompt", () => {
  const { adapter } = makeAdapter();
  const normalized = adapter.normalizeIncomingMessage({
    message: {
      content: "这句让我烦",
      kind: "c2c",
      senderId: "qq-user",
      messageId: "msg-quote",
      refMsgIdx: "quoted-7",
      msgElements: [{ content: "宝宝现在到底在烦什么？" }],
      replyTarget: { scope: "c2c", targetId: "qq-user" },
    },
  });

  assert.match(normalized.text, /<quoted_message ref_id="quoted-7">/);
  assert.match(normalized.text, /宝宝现在到底在烦什么？/);
  assert.match(normalized.text, /这句让我烦/);
});

test("QQ prefers the SDK-resolved quote and escapes it safely", () => {
  assert.deepEqual(normalizeQqbotQuote({
    refMsgIdx: "quoted-8",
    __cyberbossQuote: { refKey: "quoted-8", text: "一条已解析的引用" },
    msgElements: [{ content: "fallback" }],
  }), {
    refId: "quoted-8",
    text: "一条已解析的引用",
  });

  const { adapter } = makeAdapter();
  const normalized = adapter.normalizeIncomingMessage({
    message: {
      content: "接着说",
      kind: "c2c",
      senderId: "qq-user",
      messageId: "msg-quote-escaped",
      refMsgIdx: "quoted-9",
      msgElements: [{ content: "<tag>&内容" }],
      replyTarget: { scope: "c2c", targetId: "qq-user" },
    },
  });
  assert.match(normalized.text, /&lt;tag&gt;&amp;内容/);
});

test("unlisted QQ peers are rejected", () => {
  const { adapter } = makeAdapter();
  const normalized = adapter.normalizeIncomingMessage({
    message: {
      content: "blocked",
      kind: "c2c",
      senderId: "someone-else",
      messageId: "msg-3",
      replyTarget: { scope: "c2c", targetId: "someone-else" },
    },
  });
  assert.equal(normalized, null);
});

test("inbound message id is reused for the QQ reply", async () => {
  const { adapter, fakeBot } = makeAdapter();
  const updatesPromise = adapter.getUpdates({ timeoutMs: 100 });
  await new Promise((resolve) => setImmediate(resolve));
  fakeBot.emit("message", {}, {
    content: "hello",
    kind: "c2c",
    senderId: "qq-user",
    messageId: "incoming-msg",
    replyTarget: { scope: "c2c", targetId: "qq-user" },
  });
  const updates = await updatesPromise;

  assert.equal(updates.length, 1);
  await adapter.sendText({ text: "world", contextToken: "qqbot:c2c:qq-user" });
  assert.deepEqual(fakeBot.sentText, [{
    target: { scope: "c2c", targetId: "qq-user", msgId: "incoming-msg" },
    text: "world",
  }]);
});

test("QQ uses the Weixin natural sentence chunking for separate bubbles", async () => {
  const { adapter, fakeBot } = makeAdapter();

  await adapter.sendText({
    text: "第一句。第二句！第三句？",
    contextToken: "qqbot:c2c:qq-user",
  });

  assert.deepEqual(fakeBot.sentText.map((item) => item.text), [
    "第一句",
    "第二句！",
    "第三句？",
  ]);
});

test("QQ preserves a deferred block as one bubble when it fits", async () => {
  const { adapter, fakeBot } = makeAdapter();

  await adapter.sendText({
    text: "前一轮。\n\n===== 本轮模型回复 =====\n这一轮。",
    contextToken: "qqbot:c2c:qq-user",
    preserveBlock: true,
  });

  assert.deepEqual(fakeBot.sentText.map((item) => item.text), [
    "前一轮。\n\n===== 本轮模型回复 =====\n这一轮",
  ]);
});

test("QQ synthesizes an explicitly marked voice and hides the marker from text", async () => {
  const audio = Buffer.from("voice-audio");
  const { adapter, fakeBot } = makeAdapter({
    elevenLabsApiKey: "tts-key",
    elevenLabsVoiceId: "voice-id",
  }, new FakeBot(), {
    synthesizeSpeech: async (text) => {
      assert.equal(text, "I missed you, baby.");
      return audio;
    },
  });

  await adapter.sendText({
    text: "<qq_voice>I missed you, baby.</qq_voice>\n\n老公想宝宝了。",
    contextToken: "qqbot:c2c:qq-user",
  });

  assert.equal(fakeBot.sentVoice.length, 1);
  assert.deepEqual(fakeBot.sentVoice[0].source, { buffer: audio });
  assert.deepEqual(fakeBot.sentText.map((item) => item.text), ["老公想宝宝了"]);
});

test("QQ sends pictures inline and other local artifacts as files", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-qqbot-media-test-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const imagePath = path.join(tempDir, "sticker.gif");
  const filePath = path.join(tempDir, "notes.txt");
  fs.writeFileSync(imagePath, "GIF89a");
  fs.writeFileSync(filePath, "notes");
  const { adapter, fakeBot } = makeAdapter();

  await adapter.sendFile({ filePath: imagePath, contextToken: "qqbot:c2c:qq-user" });
  await adapter.sendFile({ filePath, contextToken: "qqbot:c2c:qq-user" });

  assert.equal(fakeBot.sentMedia[0].fileType, "image");
  assert.equal(fakeBot.sentMedia[1].fileType, "file");
  assert.equal(fakeBot.sentMedia[0].target.targetId, "qq-user");
});

test("QQ reply target parsing and text chunking are deterministic", () => {
  assert.deepEqual(resolveReplyTarget("qqbot:group:g-1", ""), {
    contextToken: "qqbot:group:g-1",
    replyTarget: { scope: "group", targetId: "g-1" },
  });
  assert.deepEqual(splitText("abcdef", 2), ["ab", "cd", "ef"]);
  assert.deepEqual(buildQqbotTextDelivery("一句。二句！", { minChunkChars: 2 }).sendChunks, [
    "一句。",
    "二句！",
  ]);
});

test("QQ remains the persisted reply provider for a shared binding", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-qqbot-test-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const store = new SessionStore({ filePath: path.join(tempDir, "sessions.json"), runtimeId: "codex" });
  const bindingKey = store.buildBindingKey({
    workspaceId: "default",
    accountId: "weixin-account",
    senderId: "weixin-user",
  });

  store.setLastReplyTarget(bindingKey, {
    userId: "weixin-user",
    contextToken: "qqbot:c2c:qq-user",
    provider: "qqbot",
  });

  assert.equal(store.getLastReplyTarget(bindingKey).provider, "qqbot");
  assert.equal(resolveCurrentChatContextToken({
    sessionStore: store,
    context: { bindingKey },
    userId: "weixin-user",
    fallbackContextToken: "weixin-context",
  }), "qqbot:c2c:qq-user");
});
