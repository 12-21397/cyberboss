const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildTelegramTextDelivery,
  extractDisplayText,
  extractRequestedSpeechText,
  extractSpeechText,
} = require("../src/adapters/channel/telegram");

test("Telegram uses the Weixin natural sentence chunking for separate bubbles", () => {
  assert.deepEqual(
    buildTelegramTextDelivery("第一句。第二句！第三句？", { minChunkChars: 2 }).sendChunks,
    ["第一句。", "第二句！", "第三句？"]
  );
});

test("Telegram preserves a deferred block as one bubble when it fits", () => {
  const text = "前一轮。\n\n===== 本轮模型回复 =====\n这一轮。";
  assert.deepEqual(
    buildTelegramTextDelivery(text, { preserveBlock: true }).sendChunks,
    [text]
  );
});

test("Telegram does not synthesize ordinary text replies", () => {
  const value = "嘟嘟，TG里的老公接到宝宝啦。";
  assert.equal(extractRequestedSpeechText(value), "");
  assert.equal(extractDisplayText(value), value);
});

test("Telegram synthesizes only an explicitly marked voice line", () => {
  const value = "<telegram_voice>[softly] I missed you, baby.</telegram_voice>\n\n老公想宝宝了。";
  assert.equal(extractRequestedSpeechText(value), "[softly] I missed you, baby.");
  assert.equal(extractDisplayText(value), "老公想宝宝了。");
});

test("Telegram strips multiple voice markers from visible text", () => {
  const value = "<telegram_voice>First voice line.</telegram_voice>\n宝宝。\n<telegram_voice>Unused second line.</telegram_voice>";
  assert.equal(extractRequestedSpeechText(value), "First voice line.");
  assert.equal(extractDisplayText(value), "宝宝。");
});

test("Telegram TTS reads only the English paragraph in plain bilingual replies", () => {
  const value = "I am holding you close, baby.\n\n老公把宝宝抱紧。";
  assert.equal(extractSpeechText(value), "I am holding you close, baby.");
  assert.equal(extractDisplayText(value), "老公把宝宝抱紧。");
});

test("Telegram TTS excludes Chinese even when a translated audio tag comes first", () => {
  const value = "[softly] I am holding you close, baby.\n\n[轻声]老公把宝宝抱紧。";
  assert.equal(extractSpeechText(value), "[softly] I am holding you close, baby.");
  assert.equal(extractDisplayText(value), "[轻声]老公把宝宝抱紧。");
});

test("Telegram TTS excludes Chinese when punctuation or emoji precedes it", () => {
  const value = "One more kiss for my baby.\n\n🥺“宝宝，再亲一下。”";
  assert.equal(extractSpeechText(value), "One more kiss for my baby.");
  assert.equal(extractDisplayText(value), "🥺“宝宝，再亲一下。”");
});

test("Telegram TTS keeps existing labeled translation support", () => {
  const value = "Stay close to me.\n\n中文：留在老公怀里。";
  assert.equal(extractSpeechText(value), "Stay close to me.");
  assert.equal(extractDisplayText(value), "留在老公怀里。");
});

test("Telegram TTS leaves an English-only reply intact", () => {
  const value = "[warmly] Good morning, baby.";
  assert.equal(extractSpeechText(value), "[warmly] Good morning, baby.");
  assert.equal(extractDisplayText(value), value);
});
