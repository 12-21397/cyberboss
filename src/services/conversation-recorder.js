const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

class ConversationRecorder {
  constructor({ dirPath } = {}) {
    this.dirPath = dirPath || "";
  }

  recordInboundMessage({ prepared, threadId = "", turnId = "", workspaceRoot = "" } = {}) {
    if (!prepared) {
      return null;
    }
    return this.append({
      type: "user",
      timestamp: normalizeIsoTime(prepared.receivedAt) || new Date().toISOString(),
      threadId,
      turnId,
      workspaceRoot: workspaceRoot || prepared.workspaceRoot || "",
      text: normalizeText(prepared.text),
      meta: {
        accountId: prepared.accountId || "",
        senderId: prepared.senderId || "",
        chatId: prepared.chatId || "",
        messageId: prepared.messageId || "",
        provider: prepared.provider || "",
        attachments: normalizeAttachments(prepared.attachments),
      },
    });
  }

  recordRuntimeEvent(event, { workspaceRoot = "" } = {}) {
    const type = mapRuntimeEventType(event?.type);
    if (!type) {
      return null;
    }
    const payload = event?.payload || {};
    return this.append({
      type,
      timestamp: normalizeIsoTime(payload.timestamp) || new Date().toISOString(),
      threadId: normalizeText(payload.threadId),
      turnId: normalizeText(payload.turnId),
      workspaceRoot,
      text: resolveRuntimeEventText(event),
      meta: {
        itemId: payload.itemId || "",
        requestId: payload.requestId ?? null,
        kind: payload.kind || "",
        reason: payload.reason || "",
        command: payload.command || "",
        filePath: payload.filePath || "",
        filePaths: Array.isArray(payload.filePaths) ? payload.filePaths : [],
        commandTokens: Array.isArray(payload.commandTokens) ? payload.commandTokens : [],
      },
    });
  }

  append(entry) {
    if (!this.dirPath || !entry || typeof entry !== "object") {
      return null;
    }
    const timestamp = normalizeIsoTime(entry.timestamp) || new Date().toISOString();
    const normalized = {
      id: entry.id || crypto.randomUUID(),
      type: normalizeText(entry.type),
      timestamp,
      threadId: normalizeText(entry.threadId),
      turnId: normalizeText(entry.turnId),
      workspaceRoot: normalizeText(entry.workspaceRoot),
      text: typeof entry.text === "string" ? entry.text : "",
      meta: entry.meta && typeof entry.meta === "object" ? entry.meta : {},
    };
    if (!normalized.type) {
      return null;
    }
    fs.mkdirSync(this.dirPath, { recursive: true });
    fs.appendFileSync(path.join(this.dirPath, `${timestamp.slice(0, 10)}.jsonl`), `${JSON.stringify(normalized)}\n`, "utf8");
    return normalized;
  }
}

function mapRuntimeEventType(type) {
  switch (type) {
    case "runtime.reply.completed":
      return "assistant";
    case "runtime.thinking":
      return "thinking";
    case "runtime.tool.use":
      return "tool_use";
    case "runtime.tool.result":
      return "tool_result";
    case "runtime.approval.requested":
      return "approval";
    case "runtime.turn.failed":
      return "assistant";
    default:
      return "";
  }
}

function resolveRuntimeEventText(event) {
  const payload = event?.payload || {};
  if (event?.type === "runtime.approval.requested") {
    return [payload.reason, payload.command].map(normalizeText).filter(Boolean).join("\n");
  }
  return normalizeText(payload.text);
}

function normalizeAttachments(attachments) {
  return Array.isArray(attachments)
    ? attachments.map((entry) => ({
      kind: normalizeText(entry?.kind || entry?.type),
      label: normalizeText(entry?.label),
      fileName: normalizeText(entry?.fileName || entry?.name),
      filePath: normalizeText(entry?.filePath || entry?.absolutePath || entry?.path),
    })).filter((entry) => entry.kind || entry.fileName || entry.filePath)
    : [];
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeIsoTime(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return "";
  }
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : "";
}

module.exports = { ConversationRecorder };
