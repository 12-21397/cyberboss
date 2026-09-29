const fs = require("fs");
const https = require("https");
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

const TELEGRAM_TEXT_CHUNK_SIZE = 3800;
const TELEGRAM_MAX_DELIVERY_MESSAGES = 10;
const TELEGRAM_SEND_MESSAGE_CHUNK_INTERVAL_MS = 350;

function createTelegramChannelAdapter(config, { accountId, getMinChunkChars } = {}) {
  const token = String(config.telegramBotToken || "").trim();
  const allowed = new Set((config.telegramAllowedUserIds || []).map(String));
  const allowedGroups = new Set((config.telegramAllowedGroupIds || []).map(String));
  const primarySenderId = String(config.telegramPrimaryWeixinUserId || "").trim();
  const offsetFile = config.telegramOffsetFile;
  const groupContextFile = config.telegramGroupContextFile;
  const groupDiscoveryFile = config.telegramGroupDiscoveryFile;
  const enabled = Boolean(token && allowed.size && primarySenderId);
  const tts = {
    apiKey: String(config.elevenLabsApiKey || "").trim(),
    voiceId: String(config.elevenLabsVoiceId || "").trim(),
    modelId: String(config.elevenLabsModelId || "eleven_v3").trim(),
    outputFormat: String(config.elevenLabsOutputFormat || "mp3_44100_128").trim(),
  };
  const ttsEnabled = config.telegramTtsEnabled !== false && Boolean(tts.apiKey && tts.voiceId);
  let botIdentityPromise;

  async function call(method, params = {}) {
    const url = new URL(`https://api.telegram.org/bot${token}/${method}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
    }
    const data = await requestJson(url, resolveProxyAgent());
    if (!data.ok) throw new Error(`Telegram ${method} failed: ${data.description || "unknown error"}`);
    return data.result;
  }

  function resolveProxyAgent() {
    const proxy = String(process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY || "").trim();
    return proxy ? new HttpsProxyAgent(proxy) : undefined;
  }

  function loadOffset() {
    try { return Number(JSON.parse(fs.readFileSync(offsetFile, "utf8")).nextOffset) || 0; } catch { return 0; }
  }

  function saveOffset(nextOffset) {
    fs.mkdirSync(path.dirname(offsetFile), { recursive: true });
    fs.writeFileSync(offsetFile, `${JSON.stringify({ nextOffset }, null, 2)}\n`, "utf8");
  }

  function getBotIdentity() {
    if (!botIdentityPromise) {
      botIdentityPromise = call("getMe").then((bot) => ({
        id: String(bot?.id || ""),
        username: String(bot?.username || "").toLowerCase(),
      })).catch((error) => {
        botIdentityPromise = undefined;
        throw error;
      });
    }
    return botIdentityPromise;
  }

  function isPrivateAllowed(message) {
    return message?.chat?.type === "private" && allowed.has(String(message.from?.id || ""));
  }

  function isAllowedGroup(message) {
    const chatType = message?.chat?.type;
    return (chatType === "group" || chatType === "supergroup")
      && allowedGroups.has(String(message.chat?.id || ""));
  }

  function shouldWakeForGroupMessage(message, bot) {
    if (!isAllowedGroup(message)) return false;
    const text = String(message.text || "");
    const mentioned = bot.username && text.toLowerCase().includes(`@${bot.username}`);
    const replied = bot.id && String(message.reply_to_message?.from?.id || "") === bot.id;
    return mentioned || replied;
  }

  function appendGroupContext(message) {
    if (!groupContextFile || !isAllowedGroup(message) || !message.text) return;
    fs.mkdirSync(path.dirname(groupContextFile), { recursive: true });
    fs.appendFileSync(groupContextFile, `${JSON.stringify({
      timestamp: new Date(Number(message.date || 0) * 1000 || Date.now()).toISOString(),
      chatId: String(message.chat.id),
      messageId: String(message.message_id),
      senderId: String(message.from?.id || ""),
      senderName: [message.from?.first_name, message.from?.last_name].filter(Boolean).join(" ")
        || String(message.from?.username || ""),
      username: String(message.from?.username || ""),
      isBot: Boolean(message.from?.is_bot),
      text: String(message.text),
    })}\n`, "utf8");
  }

  function appendGroupDiscovery(source) {
    const chat = source?.chat;
    const chatType = chat?.type;
    if (!groupDiscoveryFile || (chatType !== "group" && chatType !== "supergroup")) return;
    fs.mkdirSync(path.dirname(groupDiscoveryFile), { recursive: true });
    fs.appendFileSync(groupDiscoveryFile, `${JSON.stringify({
      timestamp: new Date(Number(source.date || 0) * 1000 || Date.now()).toISOString(),
      chatId: String(chat.id),
      type: chatType,
      title: String(chat.title || ""),
    })}\n`, "utf8");
  }

  function loadRecentGroupContext(chatId, limit = 30) {
    try {
      return fs.readFileSync(groupContextFile, "utf8").trim().split("\n")
        .map((line) => JSON.parse(line))
        .filter((entry) => String(entry.chatId) === String(chatId))
        .slice(-limit);
    } catch {
      return [];
    }
  }

  return {
    enabled,
    describe() {
      return { id: "telegram", enabled, allowedUsers: allowed.size, allowedGroups: allowedGroups.size, ttsEnabled };
    },
    async getUpdates({ timeoutMs = 5_000 } = {}) {
      if (!enabled) return [];
      const bot = await getBotIdentity();
      const updates = await call("getUpdates", {
        offset: loadOffset(), timeout: Math.max(0, Math.min(5, Math.floor(timeoutMs / 1000))),
        allowed_updates: JSON.stringify(["message", "my_chat_member"]),
      });
      if (updates.length) saveOffset(Math.max(...updates.map((item) => Number(item.update_id))) + 1);
      const accepted = [];
      for (const item of updates) {
        const message = item?.message;
        appendGroupDiscovery(item?.my_chat_member);
        appendGroupDiscovery(message);
        if (isPrivateAllowed(message)) {
          accepted.push({ ...item, __cyberbossProvider: "telegram" });
          continue;
        }
        if (!isAllowedGroup(message)) continue;
        appendGroupContext(message);
        if (shouldWakeForGroupMessage(message, bot)) {
          accepted.push({
            ...item,
            __cyberbossProvider: "telegram",
            __cyberbossTelegramGroupContext: loadRecentGroupContext(message.chat.id),
          });
        }
      }
      return accepted;
    },
    normalizeIncomingMessage(update) {
      const message = update?.message;
      const text = String(message?.text || "").trim();
      if (!message || !text) return null;
      const chatType = message.chat?.type;
      const privateMessage = chatType === "private" && allowed.has(String(message.from?.id || ""));
      const groupMessage = (chatType === "group" || chatType === "supergroup")
        && allowedGroups.has(String(message.chat?.id || ""));
      if (!privateMessage && !groupMessage) return null;
      const chatId = String(message.chat.id);
      const username = String(message.from?.username || "");
      const groupContext = Array.isArray(update.__cyberbossTelegramGroupContext)
        ? update.__cyberbossTelegramGroupContext
          .filter((entry) => String(entry.messageId) !== String(message.message_id))
          .map((entry) => `${entry.senderName || entry.username || entry.senderId}: ${entry.text}`)
          .join("\n")
        : "";
      const contextBlock = groupContext
        ? `<telegram_group_background>\n${groupContext}\n</telegram_group_background>\n\n`
        : "";
      const wrapped = `${contextBlock}<channel source="telegram" chat_id="${chatId}" message_id="${message.message_id}" user_id="${message.from.id}" username="${username}">\n${text}\n</channel>\n\nThis turn came from Telegram. Reply normally; Cyberboss will deliver this turn's reply back to Telegram, not WeChat.`;
      return {
        provider: "telegram",
        accountId: typeof accountId === "function" ? accountId() : String(config.accountId || ""),
        workspaceId: config.workspaceId,
        senderId: primarySenderId,
        chatId,
        messageId: String(message.message_id),
        threadKey: `telegram:${chatId}`,
        text: wrapped,
        commandText: text,
        attachments: [],
        contextToken: `telegram:${chatId}`,
        receivedAt: new Date(Number(message.date || 0) * 1000 || Date.now()).toISOString(),
      };
    },
    async sendText({ text, contextToken = "", userId = "", preserveBlock = false } = {}) {
      if (!enabled) throw new Error("Telegram channel is not configured");
      const chatId = String(contextToken).startsWith("telegram:") ? String(contextToken).slice(9) : String(userId);
      if (ttsEnabled) {
        const spokenText = extractRequestedSpeechText(text);
        if (spokenText) {
          try {
            await call("sendChatAction", { chat_id: chatId, action: "record_voice" });
            const audio = await synthesizeElevenLabsSpeech(spokenText, tts, resolveProxyAgent());
            await sendTelegramVoice({ token, chatId, audio, agent: resolveProxyAgent() });
          } catch (error) {
            console.error(`[cyberboss] telegram tts failed: ${error.message}`);
          }
        }
      }
      const displayText = extractDisplayText(text);
      const delivery = buildTelegramTextDelivery(displayText, {
        preserveBlock,
        minChunkChars: typeof getMinChunkChars === "function"
          ? getMinChunkChars()
          : DEFAULT_MIN_WEIXIN_CHUNK,
      });
      for (let index = 0; index < delivery.sendChunks.length; index += 1) {
        const chunk = finalizeWeixinDeliveryChunk(delivery.sendChunks[index]);
        if (chunk) {
          await call("sendMessage", { chat_id: chatId, text: chunk });
        }
        if (index < delivery.sendChunks.length - 1) {
          await sleep(TELEGRAM_SEND_MESSAGE_CHUNK_INTERVAL_MS);
        }
      }
      return {
        sentMessageCount: delivery.sendChunks.length,
        overflowText: delivery.overflowText,
      };
    },
    async sendTyping({ contextToken = "", userId = "" } = {}) {
      if (!enabled) return;
      const chatId = String(contextToken).startsWith("telegram:") ? String(contextToken).slice(9) : String(userId);
      await call("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
    },
    async sendFile() { throw new Error("Telegram attachments are not enabled yet"); },
  };
}

function buildTelegramTextDelivery(text, { preserveBlock = false, minChunkChars = DEFAULT_MIN_WEIXIN_CHUNK } = {}) {
  const normalizedContent = normalizeWeixinReplyText(text);
  if (!normalizedContent) {
    return { sendChunks: [], overflowText: "" };
  }
  if (preserveBlock) {
    return partitionHardChunksForWeixinDelivery(
      splitUtf8(normalizedContent, TELEGRAM_TEXT_CHUNK_SIZE),
      TELEGRAM_MAX_DELIVERY_MESSAGES
    );
  }
  const naturalChunks = chunkReplyTextForWeixin(normalizedContent, minChunkChars)
    .flatMap((chunk) => splitUtf8(chunk, TELEGRAM_TEXT_CHUNK_SIZE));
  return partitionChunksForWeixinDelivery(
    naturalChunks,
    TELEGRAM_MAX_DELIVERY_MESSAGES,
    TELEGRAM_TEXT_CHUNK_SIZE
  );
}

function requestJson(url, agent) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { agent, timeout: 15_000 }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        try {
          const data = JSON.parse(body);
          if ((response.statusCode || 500) >= 400) {
            reject(new Error(`Telegram HTTP ${response.statusCode}: ${data.description || body}`));
            return;
          }
          resolve(data);
        } catch (error) {
          reject(new Error(`Telegram returned invalid JSON: ${error.message}`));
        }
      });
    });
    request.on("timeout", () => request.destroy(new Error("Telegram request timed out")));
    request.on("error", reject);
  });
}

function requestBuffer(url, { method = "GET", headers = {}, body, agent } = {}) {
  return new Promise((resolve, reject) => {
    const request = https.request(url, { method, headers, agent, timeout: 60_000 }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const data = Buffer.concat(chunks);
        if ((response.statusCode || 500) >= 400) {
          reject(new Error(`HTTP ${response.statusCode}: ${data.toString("utf8").slice(0, 500)}`));
          return;
        }
        resolve(data);
      });
    });
    request.on("timeout", () => request.destroy(new Error("request timed out")));
    request.on("error", reject);
    if (body) request.write(body);
    request.end();
  });
}

async function synthesizeElevenLabsSpeech(text, config, agent) {
  const body = Buffer.from(JSON.stringify({ text, model_id: config.modelId }), "utf8");
  const url = new URL(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(config.voiceId)}`);
  url.searchParams.set("output_format", config.outputFormat);
  return requestBuffer(url, {
    method: "POST",
    agent,
    headers: {
      Accept: "audio/mpeg",
      "Content-Type": "application/json",
      "Content-Length": body.length,
      "xi-api-key": config.apiKey,
    },
    body,
  });
}

async function sendTelegramVoice({ token, chatId, audio, agent }) {
  const boundary = `----cyberboss-${Date.now().toString(16)}`;
  const before = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n`
      + `--${boundary}\r\nContent-Disposition: form-data; name="voice"; filename="lintuan.mp3"\r\n`
      + "Content-Type: audio/mpeg\r\n\r\n",
    "utf8"
  );
  const after = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  const body = Buffer.concat([before, audio, after]);
  const response = await requestBuffer(new URL(`https://api.telegram.org/bot${token}/sendVoice`), {
    method: "POST",
    agent,
    headers: {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      "Content-Length": body.length,
    },
    body,
  });
  const parsed = JSON.parse(response.toString("utf8"));
  if (!parsed.ok) throw new Error(`Telegram sendVoice failed: ${parsed.description || "unknown error"}`);
  return parsed.result;
}

function normalizeSpeechText(value) {
  return String(value || "")
    .replace(/\[([^\]]+)]\((https?:\/\/[^)]+)\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/[`*_#>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractSpeechText(value) {
  const text = String(value || "");
  const marker = text.search(/\n\s*(?:中文|Chinese translation)\s*[:：]/i);
  if (marker >= 0) return normalizeSpeechText(text.slice(0, marker));
  const directTranslation = findDirectTranslationBoundary(text);
  return normalizeSpeechText(directTranslation >= 0 ? text.slice(0, directTranslation) : text);
}

function extractRequestedSpeechText(value) {
  const match = String(value || "").match(/<telegram_voice>([\s\S]*?)<\/telegram_voice>/i);
  return match ? normalizeSpeechText(match[1]) : "";
}

function extractDisplayText(value) {
  const text = String(value || "")
    .replace(/<telegram_voice>[\s\S]*?<\/telegram_voice>/gi, "")
    .trim();
  const labeledMarker = text.search(/\n\s*(?:中文|Chinese translation)\s*[:：]/i);
  if (labeledMarker >= 0) {
    return text.slice(labeledMarker).replace(/^\s*(?:中文|Chinese translation)\s*[:：]\s*/i, "").trim();
  }
  const directTranslation = findDirectTranslationBoundary(text);
  return directTranslation >= 0 ? text.slice(directTranslation).trim() : text;
}

function findDirectTranslationBoundary(value) {
  return String(value || "").search(/\r?\n[ \t]*\r?\n(?=[^\r\n]*[\u3400-\u9fff])/u);
}

function splitText(value, limit) {
  const text = String(value || "");
  const result = [];
  for (let index = 0; index < text.length; index += limit) result.push(text.slice(index, index + limit));
  return result.length ? result : [""];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  buildTelegramTextDelivery,
  createTelegramChannelAdapter,
  extractDisplayText,
  extractRequestedSpeechText,
  extractSpeechText,
  normalizeSpeechText,
  synthesizeElevenLabsSpeech,
  sendTelegramVoice,
};
