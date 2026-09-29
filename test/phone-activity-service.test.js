const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const {
  PhoneActivityService,
  buildSnapshot,
  formatPhoneActivityContext,
} = require("../src/services/phone-activity-service");

function createService(config = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-phone-activity-"));
  return new PhoneActivityService({
    config: {
      phoneActivityFile: path.join(tempDir, "phone-activity.json"),
      phoneActivityToken: "test-token",
      ...config,
    },
  });
}

test("phone activity records switches, closes, and durations", () => {
  const service = createService();
  const now = new Date();
  const openedWechatAt = new Date(now.getTime() - 5 * 60 * 1000).toISOString();
  const openedQqAt = new Date(now.getTime() - 3 * 60 * 1000).toISOString();
  const closedQqAt = new Date(now.getTime() - 10 * 1000).toISOString();

  service.ingest({ appName: "微信", event: "open", timestamp: openedWechatAt });
  service.ingest({ appName: "QQ", event: "open", timestamp: openedQqAt });
  service.ingest({ appName: "QQ", event: "close", timestamp: closedQqAt });

  const state = service.readState();
  const snapshot = buildSnapshot(state, now);
  assert.equal(snapshot.current, null);
  assert.equal(snapshot.recentSessions.length, 2);
  assert.equal(snapshot.recentSessions[1].appName, "微信");
  assert.equal(snapshot.recentSessions[1].closeReason, "inferred_switch");
  assert.equal(snapshot.recentSessions[1].durationSeconds, 120);
  assert.equal(snapshot.recentSessions[0].appName, "QQ");
  assert.equal(snapshot.recentSessions[0].closeReason, "reported_close");
  assert.equal(snapshot.recentSessions[0].durationSeconds, 170);
  assert.match(formatPhoneActivityContext(service.filePath, now), /最近信号是 QQ 关闭/);
});

test("phone activity HTTP endpoint requires bearer auth and accepts an app event", async () => {
  const service = createService({ phoneActivityHost: "127.0.0.1" });
  service.port = 0;
  await service.startServer();
  const port = service.server.address().port;
  try {
    const unauthorized = await fetch(`http://127.0.0.1:${port}/phone-activity/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appName: "小红书", event: "open" }),
    });
    assert.equal(unauthorized.status, 401);

    const accepted = await fetch(`http://127.0.0.1:${port}/phone-activity/ingest`, {
      method: "POST",
      headers: {
        Authorization: "Bearer test-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ appName: "小红书", event: "open", source: "shortcuts" }),
    });
    assert.equal(accepted.status, 202);
    assert.equal((await accepted.json()).appName, "小红书");
    assert.equal(service.snapshot().current.appName, "小红书");
  } finally {
    await service.closeServer();
  }
});

test("phone activity accepts Shortcut values wrapped as arrays or value objects", () => {
  const service = createService();
  service.ingest({
    appName: [{ Value: "QQ" }],
    event: ["open"],
    source: { value: "shortcuts" },
  });
  assert.equal(service.snapshot().current.appName, "QQ");
  assert.equal(service.snapshot().recentEvents[0].event, "open");
});
