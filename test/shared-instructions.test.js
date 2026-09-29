const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const {
  buildContinuityTurnText,
  buildOpeningTurnText,
} = require("../src/adapters/runtime/shared-instructions");

function createConfig() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-shared-instructions-"));
  const paths = {
    weixinInstructionsFile: path.join(tempDir, "weixin-instructions.md"),
    relationshipCoreFile: path.join(tempDir, "relationship_core.md"),
    routineAnchorsFile: path.join(tempDir, "routine_anchors.md"),
    currentStateFile: path.join(tempDir, "current_state.md"),
    weixinOperationsFile: path.join(tempDir, "weixin-operations.md"),
    phoneActivityFile: path.join(tempDir, "phone-activity.json"),
  };
  fs.writeFileSync(paths.weixinInstructionsFile, "persona", "utf8");
  fs.writeFileSync(paths.relationshipCoreFile, "relationship v1", "utf8");
  fs.writeFileSync(paths.routineAnchorsFile, "routine", "utf8");
  fs.writeFileSync(paths.currentStateFile, "state", "utf8");
  fs.writeFileSync(paths.weixinOperationsFile, "operations", "utf8");
  return { tempDir, ...paths };
}

test("opening turn includes persona and active relationship core", () => {
  const config = createConfig();
  const text = buildOpeningTurnText(config, "hello");
  assert.match(text, /persona/);
  assert.match(text, /## Active Relationship Core/);
  assert.match(text, /relationship v1/);
  assert.doesNotMatch(text, /Current State Continuity/);
  assert.doesNotMatch(text, /\nstate\n/);
  assert.match(text, /Current user message:\nhello/);
});

test("existing thread injects relationship core once and refreshes after a content change", () => {
  const config = createConfig();
  const cacheKey = `thread-${Date.now()}-${Math.random()}`;
  const first = buildContinuityTurnText(config, "first", { cacheKey });
  assert.match(first, /Active relationship core:\nrelationship v1/);
  assert.doesNotMatch(first, /Current state continuity/);

  const second = buildContinuityTurnText(config, "second", { cacheKey });
  assert.equal(second, "second");

  fs.writeFileSync(config.relationshipCoreFile, "relationship version two", "utf8");
  const future = new Date(Date.now() + 2000);
  fs.utimesSync(config.relationshipCoreFile, future, future);
  const refreshed = buildContinuityTurnText(config, "third", { cacheKey });
  assert.match(refreshed, /Active relationship core:\nrelationship version two/);
  assert.doesNotMatch(refreshed, /Stable routine anchors/);
  assert.doesNotMatch(refreshed, /Current state continuity/);
  assert.match(refreshed, /Current user message:\nthird/);
});
