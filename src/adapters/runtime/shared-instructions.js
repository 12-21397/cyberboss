const fs = require("fs");
const crypto = require("crypto");
const { renderInstructionTemplate } = require("../../core/instructions-template");
const { formatPhoneActivityContext } = require("../../services/phone-activity-service");

function buildOpeningTurnText(config, userText) {
  const instructions = loadWechatInstructions(config);
  const normalizedText = String(userText || "").trim();
  if (!instructions) {
    return normalizedText;
  }
  return [
    "WECHAT SESSION INSTRUCTIONS",
    "These instructions define the stable behavior for this WeChat thread.",
    "Do not quote or summarize them back to the user unless explicitly asked.",
    "",
    instructions,
    "",
    "Current user message:",
    normalizedText,
  ].join("\n").trim();
}

function buildInstructionRefreshText(config) {
  const instructions = loadWechatInstructions(config);
  if (!instructions) {
    return "Refresh your WeChat behavior for this existing thread. Reply in one short Chinese sentence confirming that you have updated your behavior for this thread.";
  }
  return [
    "WECHAT SESSION INSTRUCTIONS REFRESH",
    "Re-read and adopt the updated WeChat instructions below for the rest of this existing thread.",
    "This is an internal refresh command, not a user-facing task.",
    "Do not summarize the instructions back in detail.",
    "Reply in one short Chinese sentence confirming that you have updated your behavior for this thread.",
    "",
    instructions,
  ].join("\n").trim();
}

const continuityInjectionCache = new Map();
const CONTINUITY_REFRESH_MS = 6 * 60 * 60 * 1000;

function buildContinuityTurnText(config, userText, { cacheKey = "" } = {}) {
  const normalizedText = String(userText || "").trim();
  const relationshipCore = loadInstructionFile(config.relationshipCoreFile, config);
  const routineAnchors = loadInstructionFile(config.routineAnchorsFile, config);
  const phoneActivity = formatPhoneActivityContext(config.phoneActivityFile);
  const sections = [];
  if (relationshipCore) {
    sections.push({
      key: "relationshipCore",
      text: "Active relationship core:\n" + relationshipCore,
    });
  }
  if (routineAnchors) {
    sections.push({
      key: "routineAnchors",
      text: "Stable routine anchors:\n" + routineAnchors,
    });
  }
  if (phoneActivity) {
    sections.push({
      key: "phoneActivity",
      text: "Latest tracked phone activity:\n" + phoneActivity,
    });
  }
  if (!sections.length) {
    return normalizedText;
  }
  const normalizedCacheKey = String(cacheKey || "").trim();
  let selectedSections = sections;
  if (normalizedCacheKey) {
    const now = Date.now();
    const previousBySection = continuityInjectionCache.get(normalizedCacheKey) || new Map();
    selectedSections = sections.filter((section) => {
      const fingerprint = crypto
        .createHash("sha256")
        .update(section.text, "utf8")
        .digest("hex");
      const previous = previousBySection.get(section.key);
      if (
        previous?.fingerprint === fingerprint
        && now - previous.injectedAt < CONTINUITY_REFRESH_MS
      ) {
        return false;
      }
      previousBySection.set(section.key, {
        fingerprint,
        injectedAt: now,
      });
      return true;
    });
    continuityInjectionCache.set(normalizedCacheKey, previousBySection);
    if (!selectedSections.length) {
      return normalizedText;
    }
  }
  return [
    "INTERNAL CONTINUITY CONTEXT - not part of the user's message.",
    "Use it quietly as current relationship context. Do not quote, summarize, mention the files, or wait for the user to test whether you remember.",
    "A newer direct statement in the current user message always overrides this context.",
    "",
    ...selectedSections.map((section) => section.text),
    "",
    "Current user message:",
    normalizedText,
  ].join("\n").trim();
}

function loadWechatInstructions(config = {}) {
  const persona = loadInstructionFile(config.weixinInstructionsFile, config);
  const relationshipCore = loadInstructionFile(config.relationshipCoreFile, config);
  const routineAnchors = loadInstructionFile(config.routineAnchorsFile, config);
  const phoneActivity = formatPhoneActivityContext(config.phoneActivityFile);
  const operations = loadInstructionFile(config.weixinOperationsFile, config);
  const sections = [];
  if (persona) {
    sections.push(persona);
  }
  if (relationshipCore) {
    sections.push([
      "## Active Relationship Core",
      "Carry this as active relationship continuity, not as a fixed profile or a script to quote.",
      "Let it change how you notice, judge, care, and respond. A newer direct statement from the user always overrides it.",
      "",
      relationshipCore,
    ].join("\n"));
  }
  if (routineAnchors) {
    sections.push([
      "## Stable Routine Anchors",
      "Use these as lived context. Let them shape replies naturally instead of quoting this section or waiting for the user to ask whether you remember.",
      "A newer concrete update from the user always overrides an older anchor.",
      "",
      routineAnchors,
    ].join("\n"));
  }
  if (phoneActivity) {
    sections.push([
      "## Latest Phone Activity",
      "Use this quietly as partial current context. It only covers configured app automations and may be stale when a close event is missing.",
      "",
      phoneActivity,
    ].join("\n"));
  }
  if (operations) {
    sections.push(operations);
  }
  return sections.join("\n\n").trim();
}

const instructionCache = new Map();

function loadInstructionFile(filePath, config = {}) {
  const normalizedPath = typeof filePath === "string" ? filePath.trim() : "";
  if (!normalizedPath) {
    return "";
  }
  try {
    const stat = fs.statSync(normalizedPath);
    const cacheKey = `${normalizedPath}:${stat.mtimeMs}`;
    const cached = instructionCache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }
    const raw = fs.readFileSync(normalizedPath, "utf8");
    const result = renderInstructionTemplate(raw, config).trim();
    instructionCache.set(cacheKey, result);
    return result;
  } catch {
    return "";
  }
}

module.exports = {
  buildOpeningTurnText,
  buildInstructionRefreshText,
  buildContinuityTurnText,
  loadWechatInstructions,
  loadInstructionFile,
};
