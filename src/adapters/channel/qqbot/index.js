const fs = require("fs");
const path = require("path");
const { HttpsProxyAgent } = require("https-proxy-agent");
const {
  chunkReplyTextForWeixin,
  finalizeWeixinDeliveryChunk,
  normalizeWeixinReplyText,
  partitionChunksForWeixinDelivery,
  partitionHardChunksForWeixinDelivery,
  splitUtf8,
} = require("../weixin");
const { DEFAULT_MIN_WEIXIN_CHUNK } = require("../weixin/config-store");
const {
  normalizeSpeechText,
  synthesizeElevenLabsSpeech,
} = require("../telegram");

const QQBOT_CONTEXT_PREFIX = "qqbot:";
const QQBOT_TEXT_CHUNK_SIZE = 1800;
const QQBOT_MAX_DELIVERY_MESSAGES = 10;
const QQBOT_SEND_MESSAGE_CHUNK_INTERVAL_MS = 350;

function createQqbotChannelAdapter(config, options = {}) {
  const appId = normalizeText(config.qqbotAppId);
  const appSecret = normalizeText(config.qqbotAppSecret);
  const allowedUsers = new Set(normalizeList(config.qqbotAllowedUserIds));
  const allowedGroups = new Set(normalizeList(config.qqbotAllowedGroupIds));
  const primarySenderId = normalizeText(config.qqbotPrimaryWeixinUserId)
    || normalizeList(config.allowedUserIds)[0]
    || "";
  const enabled = Boolean(
    appId
    && appSecret
    && primarySenderId
    && (allowedUsers.size || allowedGroups.size)
  );
  const accountId = typeof options.accountId === "function"
    ? options.accountId
    : () => normalizeText(options.accountId || config.accountId);
  const getMinChunkChars = typeof options.getMinChunkChars === "function"
    ? options.getMinChunkChars
    : () => DEFAULT_MIN_WEIXIN_CHUNK;
  const synthesizeSpeech = options.synthesizeSpeech || synthesizeElevenLabsSpeech;
  const tts = {
    apiKey: normalizeText(config.elevenLabsApiKey),
    voiceId: normalizeText(config.elevenLabsVoiceId),
    modelId: normalizeText(config.elevenLabsModelId || "eleven_v3"),
    outputFormat: normalizeText(config.elevenLabsOutputFormat || "mp3_44100_128"),
  };
  const ttsEnabled = config.telegramTtsEnabled !== false && Boolean(tts.apiKey && tts.voiceId);
  const loadSdk = options.loadSdk || (() => import("@tencent-connect/qqbot-nodejs"));
  const queue = [];
  const waiters = new Set();
  const lastMessageByContextToken = new Map();
  const seenMessageIds = new Set();
  let gatewayPromise;

  function isAllowedMessage(message) {
    const scope = resolveScope(message);
    if (scope === "group") {
      return matchesAllowlist(allowedGroups, resolveTargetId(message));
    }
    return scope === "c2c" && matchesAllowlist(allowedUsers, normalizeText(message?.senderId));
  }

  function enqueue(message) {
    if (!isAllowedMessage(message)) {
      const scope = resolveScope(message) || "unknown";
      const peerId = scope === "group" ? resolveTargetId(message) : normalizeText(message?.senderId);
      console.warn(`[cyberboss] ignored QQBot message scope=${scope} peer=${peerId || "unknown"}`);
      return;
    }
    const contextToken = buildContextToken(resolveScope(message), resolveTargetId(message));
    const messageId = normalizeText(message?.messageId);
    if (messageId && seenMessageIds.has(messageId)) {
      return;
    }
    if (contextToken && messageId) {
      lastMessageByContextToken.set(contextToken, { messageId, receivedAt: Date.now() });
      rememberBounded(seenMessageIds, messageId, 2_000);
    }
    queue.push({ __cyberbossProvider: "qqbot", message });
    for (const resolve of waiters) {
      resolve();
    }
    waiters.clear();
  }

  async function ensureGateway() {
    if (!enabled) {
      throw new Error("QQBot channel is not configured");
    }
    if (!gatewayPromise) {
      gatewayPromise = (async () => {
        const sdk = await loadSdk();
        const botOptions = {
          appId,
          appSecret,
          accountId: "cyberboss",
          baseUrl: normalizeText(config.qqbotBaseUrl) || "https://api.sgroup.qq.com",
          tokenBaseUrl: normalizeText(config.qqbotTokenBaseUrl) || "https://bots.qq.com",
          tokenPrefetch: "sync",
        };
        const stateDir = normalizeText(config.qqbotStateDir);
        if (stateDir && sdk.FileKVStore && sdk.kvSessionPersistence) {
          fs.mkdirSync(stateDir, { recursive: true });
          botOptions.sessionPersistence = sdk.kvSessionPersistence({
            store: new sdk.FileKVStore({ dir: stateDir, fileName: "session.json" }),
            accountId: "cyberboss",
          });
        }
        const bot = options.createBot
          ? await options.createBot(botOptions, sdk)
          : new sdk.QQBot(botOptions);
        if (typeof bot.use === "function" && typeof sdk.quoteRef === "function") {
          bot.use(sdk.quoteRef({ contentLimit: 1_000, preferMsgElements: true }));
        }
        bot.on("message", (context, message) => {
          enqueue({
            ...message,
            __cyberbossQuote: context?.state?.quote,
          });
        });
        bot.on("ready", () => console.log("[cyberboss] QQBot gateway ready"));
        bot.on("resumed", () => console.log("[cyberboss] QQBot gateway resumed"));
        bot.on("error", (error) => {
          console.error(`[cyberboss] QQBot gateway error: ${error?.message || error}`);
        });
        Promise.resolve(bot.start()).catch((error) => {
          gatewayPromise = undefined;
          console.error(`[cyberboss] QQBot gateway stopped: ${error?.message || error}`);
        });
        return { bot, sdk };
      })().catch((error) => {
        gatewayPromise = undefined;
        throw error;
      });
    }
    return gatewayPromise;
  }

  return {
    enabled,
    describe() {
      return {
        id: "qqbot",
        enabled,
        allowedUsers: allowedUsers.size,
        allowedGroups: allowedGroups.size,
        sameThreadSenderId: primarySenderId,
        ttsEnabled,
      };
    },
    async getUpdates({ timeoutMs = 5_000 } = {}) {
      if (!enabled) return [];
      await ensureGateway();
      if (!queue.length) {
        await waitForMessage(waiters, timeoutMs);
      }
      return queue.splice(0, queue.length);
    },
    normalizeIncomingMessage(update) {
      const message = update?.message;
      if (!message || !isAllowedMessage(message)) return null;
      const scope = resolveScope(message);
      const targetId = resolveTargetId(message);
      const senderOpenId = normalizeText(message.senderId);
      const text = normalizeText(message.content);
      const attachments = normalizeQqbotAttachments(message.attachments);
      if (!scope || !targetId || !senderOpenId || (!text && !attachments.length)) return null;
      const messageId = normalizeText(message.messageId);
      const senderName = normalizeText(message.senderName);
      const contextToken = buildContextToken(scope, targetId);
      const quote = normalizeQqbotQuote(message);
      const quoteBlock = quote
        ? `<quoted_message ref_id="${escapeAttribute(quote.refId)}">\n${escapeElementText(quote.text)}\n</quoted_message>\n`
        : "";
      const wrapped = `<channel source="qqbot" scope="${escapeAttribute(scope)}" chat_id="${escapeAttribute(targetId)}" message_id="${escapeAttribute(messageId)}" user_id="${escapeAttribute(senderOpenId)}" username="${escapeAttribute(senderName)}">\n${quoteBlock}${text}\n</channel>\n\nThis turn came from QQ. Reply normally; Cyberboss will deliver this turn's reply back to QQ while keeping the existing shared runtime thread.`;
      return {
        provider: "qqbot",
        accountId: normalizeText(accountId()),
        workspaceId: config.workspaceId,
        // Reusing the primary Weixin sender is what binds QQ, Weixin, and the
        // terminal to the same Cyberboss runtime thread.
        senderId: primarySenderId,
        chatId: targetId,
        messageId,
        threadKey: contextToken,
        text: wrapped,
        commandText: text,
        attachments,
        contextToken,
        receivedAt: normalizeTimestamp(message.timestamp),
      };
    },
    async sendText({ text, contextToken = "", userId = "", preserveBlock = false } = {}) {
      const { bot } = await ensureGateway();
      const target = resolveReplyTarget(contextToken, userId);
      const msgId = getRecentMessageId(lastMessageByContextToken, target.contextToken);
      const replyTarget = msgId ? { ...target.replyTarget, msgId } : target.replyTarget;
      if (ttsEnabled) {
        const spokenText = extractRequestedQqSpeechText(text);
        if (spokenText) {
          try {
            await bot.sendTyping(target.replyTarget).catch(() => {});
            const audio = await synthesizeSpeech(spokenText, tts, resolveProxyAgent());
            await bot.sendVoice(replyTarget, { buffer: audio });
          } catch (error) {
            console.error(`[cyberboss] QQBot tts failed: ${error.message}`);
          }
        }
      }
      const normalizedContent = normalizeWeixinReplyText(extractQqDisplayText(text));
      if (!normalizedContent) return { sentMessageCount: 0, overflowText: "" };
      const delivery = buildQqbotTextDelivery(normalizedContent, {
        preserveBlock,
        minChunkChars: getMinChunkChars(),
      });
      for (let index = 0; index < delivery.sendChunks.length; index += 1) {
        const chunk = finalizeWeixinDeliveryChunk(delivery.sendChunks[index]);
        if (chunk) {
          await bot.sendText(replyTarget, chunk);
        }
        if (index < delivery.sendChunks.length - 1) {
          await sleep(QQBOT_SEND_MESSAGE_CHUNK_INTERVAL_MS);
        }
      }
      return {
        sentMessageCount: delivery.sendChunks.length,
        overflowText: delivery.overflowText,
      };
    },
    async sendTyping({ contextToken = "", userId = "" } = {}) {
      if (!enabled) return;
      const { bot } = await ensureGateway();
      const target = resolveReplyTarget(contextToken, userId);
      await bot.sendTyping(target.replyTarget).catch(() => {});
    },
    async sendFile({ filePath = "", contextToken = "", userId = "" } = {}) {
      const resolvedPath = path.resolve(normalizeText(filePath));
      if (!resolvedPath || !fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
        throw new Error(`QQBot file does not exist: ${resolvedPath}`);
      }
      const { bot, sdk } = await ensureGateway();
      const target = resolveReplyTarget(contextToken, userId);
      const msgId = getRecentMessageId(lastMessageByContextToken, target.contextToken);
      const replyTarget = msgId ? { ...target.replyTarget, msgId } : target.replyTarget;
      const fileType = isQqbotImageFile(resolvedPath)
        ? sdk.MediaFileType?.IMAGE
        : sdk.MediaFileType?.FILE;
      await bot.sendMedia({
        target: replyTarget,
        fileType,
        localPath: resolvedPath,
        fileName: path.basename(resolvedPath),
      });
    },
  };
}

function normalizeQqbotAttachments(value) {
  return (Array.isArray(value) ? value : [])
    .map((attachment, index) => {
      const contentType = normalizeContentType(attachment?.content_type);
      const directUrls = uniqueTextValues([
        attachment?.voice_wav_url,
        attachment?.url,
      ]);
      if (!directUrls.length) return null;
      return {
        kind: resolveQqbotAttachmentKind(contentType),
        index,
        fileName: normalizeText(attachment?.filename),
        sizeBytes: normalizePositiveInteger(attachment?.size),
        directUrls,
        mediaRef: { encryptType: 0 },
        rawItem: attachment,
      };
    })
    .filter(Boolean);
}

function normalizeQqbotQuote(message) {
  const resolved = message?.__cyberbossQuote;
  const resolvedText = normalizeText(resolved?.text);
  if (resolvedText) {
    return {
      refId: normalizeText(resolved?.refKey) || normalizeText(message?.refMsgIdx),
      text: resolvedText.slice(0, 1_000),
    };
  }
  const refId = normalizeText(message?.refMsgIdx);
  if (!refId) return null;
  const element = Array.isArray(message?.msgElements) ? message.msgElements[0] : null;
  const parts = [];
  const content = normalizeText(element?.content);
  if (content) parts.push(content);
  for (const attachment of Array.isArray(element?.attachments) ? element.attachments : []) {
    const contentType = normalizeContentType(attachment?.content_type);
    const fileName = normalizeText(attachment?.filename);
    if (contentType.startsWith("audio/")) {
      parts.push(normalizeText(attachment?.asr_refer_text) || "[voice]");
    } else if (contentType.startsWith("image/")) {
      parts.push(fileName ? `[image: ${fileName}]` : "[image]");
    } else if (contentType.startsWith("video/")) {
      parts.push(fileName ? `[video: ${fileName}]` : "[video]");
    } else {
      parts.push(fileName ? `[file: ${fileName}]` : "[file]");
    }
  }
  const text = normalizeText(parts.join("\n"));
  return text ? { refId, text: text.slice(0, 1_000) } : null;
}

function resolveQqbotAttachmentKind(contentType) {
  if (contentType.startsWith("image/")) return "image";
  if (contentType.startsWith("video/")) return "video";
  if (contentType.startsWith("audio/")) return "voice";
  return "file";
}

function isQqbotImageFile(filePath) {
  return [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"].includes(
    path.extname(normalizeText(filePath)).toLowerCase()
  );
}

function uniqueTextValues(values) {
  return Array.from(new Set((Array.isArray(values) ? values : []).map(normalizeText).filter(Boolean)));
}

function normalizeContentType(value) {
  return normalizeText(value).split(";", 1)[0].toLowerCase();
}

function normalizePositiveInteger(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function extractRequestedQqSpeechText(value) {
  const match = String(value || "").match(/<(?:qq|telegram)_voice>([\s\S]*?)<\/(?:qq|telegram)_voice>/i);
  return match ? normalizeSpeechText(match[1]) : "";
}

function extractQqDisplayText(value) {
  return String(value || "")
    .replace(/<(?:qq|telegram)_voice>[\s\S]*?<\/(?:qq|telegram)_voice>/gi, "")
    .trim();
}

function resolveProxyAgent() {
  const proxy = normalizeText(process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY);
  return proxy ? new HttpsProxyAgent(proxy) : undefined;
}

function buildQqbotTextDelivery(text, { preserveBlock = false, minChunkChars = DEFAULT_MIN_WEIXIN_CHUNK } = {}) {
  if (preserveBlock) {
    return partitionHardChunksForWeixinDelivery(
      splitUtf8(text, QQBOT_TEXT_CHUNK_SIZE),
      QQBOT_MAX_DELIVERY_MESSAGES
    );
  }
  const naturalChunks = chunkReplyTextForWeixin(text, minChunkChars)
    .flatMap((chunk) => splitUtf8(chunk, QQBOT_TEXT_CHUNK_SIZE));
  return partitionChunksForWeixinDelivery(
    naturalChunks,
    QQBOT_MAX_DELIVERY_MESSAGES,
    QQBOT_TEXT_CHUNK_SIZE
  );
}

function waitForMessage(waiters, timeoutMs) {
  const delay = Math.max(0, Number(timeoutMs) || 0);
  return new Promise((resolve) => {
    let timer;
    const done = () => {
      if (timer) clearTimeout(timer);
      waiters.delete(done);
      resolve();
    };
    waiters.add(done);
    timer = setTimeout(done, delay);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveScope(message) {
  const scope = normalizeText(message?.replyTarget?.scope || message?.kind).toLowerCase();
  return scope === "group" ? "group" : (scope === "c2c" || scope === "direct" ? "c2c" : "");
}

function resolveTargetId(message) {
  return normalizeText(message?.replyTarget?.targetId)
    || (resolveScope(message) === "group" ? normalizeText(message?.groupOpenid) : normalizeText(message?.senderId));
}

function resolveReplyTarget(contextToken, userId) {
  const normalizedToken = normalizeText(contextToken);
  if (normalizedToken.startsWith(`${QQBOT_CONTEXT_PREFIX}group:`)) {
    const targetId = normalizedToken.slice(`${QQBOT_CONTEXT_PREFIX}group:`.length);
    return { contextToken: buildContextToken("group", targetId), replyTarget: { scope: "group", targetId } };
  }
  if (normalizedToken.startsWith(`${QQBOT_CONTEXT_PREFIX}c2c:`)) {
    const targetId = normalizedToken.slice(`${QQBOT_CONTEXT_PREFIX}c2c:`.length);
    return { contextToken: buildContextToken("c2c", targetId), replyTarget: { scope: "c2c", targetId } };
  }
  const targetId = normalizeText(userId);
  if (!targetId) {
    throw new Error("Cannot determine QQBot reply target");
  }
  return { contextToken: buildContextToken("c2c", targetId), replyTarget: { scope: "c2c", targetId } };
}

function buildContextToken(scope, targetId) {
  const normalizedScope = scope === "group" ? "group" : "c2c";
  return `${QQBOT_CONTEXT_PREFIX}${normalizedScope}:${normalizeText(targetId)}`;
}

function matchesAllowlist(allowlist, value) {
  const normalized = normalizeText(value);
  return Boolean(normalized && (allowlist.has("*") || allowlist.has(normalized)));
}

function normalizeList(value) {
  return Array.isArray(value) ? value.map(normalizeText).filter(Boolean) : [];
}

function normalizeTimestamp(value) {
  const parsed = new Date(value || Date.now());
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

function getRecentMessageId(cache, contextToken) {
  const entry = cache.get(contextToken);
  if (!entry) return "";
  const ttlMs = contextToken.startsWith(`${QQBOT_CONTEXT_PREFIX}group:`)
    ? 5 * 60 * 1000
    : 30 * 60 * 1000;
  return Date.now() - entry.receivedAt < ttlMs ? entry.messageId : "";
}

function rememberBounded(values, value, limit) {
  values.add(value);
  while (values.size > limit) {
    values.delete(values.values().next().value);
  }
}

function splitText(value, maxLength) {
  const text = normalizeText(value);
  if (!text) return [];
  const chunks = [];
  for (let offset = 0; offset < text.length; offset += maxLength) {
    chunks.push(text.slice(offset, offset + maxLength));
  }
  return chunks;
}

function escapeAttribute(value) {
  return normalizeText(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeElementText(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  buildQqbotTextDelivery,
  buildContextToken,
  createQqbotChannelAdapter,
  extractQqDisplayText,
  extractRequestedQqSpeechText,
  isQqbotImageFile,
  normalizeQqbotAttachments,
  normalizeQqbotQuote,
  resolveReplyTarget,
  splitText,
};
