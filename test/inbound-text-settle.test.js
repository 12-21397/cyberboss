const assert = require("node:assert/strict");
const test = require("node:test");
const { CyberbossApp } = require("../src/core/app");

test("optional text settle window merges consecutive plain messages", async () => {
  const dispatched = [];
  const app = Object.assign(Object.create(CyberbossApp.prototype), {
    config: { inboundTextSettleMs: 5000 },
    pendingTextInboundByScope: new Map(),
    channelAdapter: { sendTyping: async () => {} },
    routePreparedInbound: async (payload) => { dispatched.push(payload); return true; },
  });
  const base = {
    workspaceId: "default", accountId: "a", senderId: "u", contextToken: "t",
    provider: "weixin", attachments: [], attachmentFailures: [],
  };
  app.enqueuePendingTextInbound({
    bindingKey: "binding", workspaceRoot: "C:\\work",
    prepared: { ...base, messageId: "1", originalText: "第一句", text: "第一句", receivedAt: "2026-09-04T11:00:00.000Z" },
  });
  app.enqueuePendingTextInbound({
    bindingKey: "binding", workspaceRoot: "C:\\work",
    prepared: { ...base, messageId: "2", originalText: "第二句", text: "第二句", receivedAt: "2026-09-04T11:00:02.000Z" },
  });
  await app.flushPendingTextInbound({ bindingKey: "binding", workspaceRoot: "C:\\work" });
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].prepared.originalText, "第一句\n\n第二句");
  assert.equal(app.pendingTextInboundByScope.size, 0);
});
