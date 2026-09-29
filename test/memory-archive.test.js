const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const { MemoryArchive } = require("../src/services/memory-archive");

test("memory archive appends messages by UTC day", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-memory-archive-"));
  const archive = new MemoryArchive({ archiveDir: path.join(tempDir, "memory", "archive") });

  archive.archiveMessage({
    messageId: "msg-1",
    text: "hello",
    timestamp: "2026-06-24T12:00:00.000Z",
  });

  const entries = archive.readDay("2026-06-24");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].messageId, "msg-1");
  assert.equal(entries[0].text, "hello");
});

test("memory archive reads most recent entries across files", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-memory-archive-"));
  const archive = new MemoryArchive({ archiveDir: path.join(tempDir, "memory", "archive") });

  archive.archiveMessages([
    { messageId: "old", timestamp: "2026-06-23T23:00:00.000Z" },
    { messageId: "new", timestamp: "2026-06-24T01:00:00.000Z" },
  ]);

  assert.deepEqual(archive.readRecent(2).map((entry) => entry.messageId), ["old", "new"]);
});
