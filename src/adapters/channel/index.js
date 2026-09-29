const { createWeixinChannelAdapter } = require("./weixin");
const { createTelegramChannelAdapter } = require("./telegram");
const { createQqbotChannelAdapter } = require("./qqbot");

function createChannelRouter(config) {
  const weixin = createWeixinChannelAdapter(config);
  const telegram = createTelegramChannelAdapter(config, {
    accountId: () => weixin.resolveAccount().accountId,
    getMinChunkChars: () => weixin.getMinChunkChars(),
  });
  const qqbot = createQqbotChannelAdapter(config, {
    accountId: () => weixin.resolveAccount().accountId,
    getMinChunkChars: () => weixin.getMinChunkChars(),
  });

  return {
    describe() {
      const base = weixin.describe();
      const ids = [base.id, telegram.enabled ? "telegram" : "", qqbot.enabled ? "qqbot" : ""].filter(Boolean);
      return {
        ...base,
        id: ids.join("+"),
        telegram: telegram.describe(),
        qqbot: qqbot.describe(),
      };
    },
    login: (...args) => weixin.login(...args),
    printAccounts: (...args) => weixin.printAccounts(...args),
    resolveAccount: (...args) => weixin.resolveAccount(...args),
    getKnownContextTokens: (...args) => weixin.getKnownContextTokens(...args),
    loadSyncBuffer: (...args) => weixin.loadSyncBuffer(...args),
    saveSyncBuffer: (...args) => weixin.saveSyncBuffer(...args),
    rememberContextToken: (...args) => weixin.rememberContextToken(...args),
    async getUpdates(options = {}) {
      if (!telegram.enabled && !qqbot.enabled) {
        return weixin.getUpdates(options);
      }
      const timeoutMs = Math.min(Number(options.timeoutMs) || 5_000, 5_000);
      const [wx, tg, qq] = await Promise.all([
        weixin.getUpdates({ ...options, timeoutMs }),
        telegram.enabled ? telegram.getUpdates({ timeoutMs }).catch((error) => {
          console.error(`[cyberboss] telegram poll failed: ${error.message}`);
          return [];
        }) : [],
        qqbot.enabled ? qqbot.getUpdates({ timeoutMs }).catch((error) => {
          console.error(`[cyberboss] QQBot poll failed: ${error.message}`);
          return [];
        }) : [],
      ]);
      return {
        ...wx,
        msgs: [...(Array.isArray(wx?.msgs) ? wx.msgs : []), ...(tg || []), ...(qq || [])],
      };
    },
    normalizeIncomingMessage(message) {
      if (message?.__cyberbossProvider === "telegram") return telegram.normalizeIncomingMessage(message);
      if (message?.__cyberbossProvider === "qqbot") return qqbot.normalizeIncomingMessage(message);
      return weixin.normalizeIncomingMessage(message);
    },
    sendText(payload = {}) {
      return resolveOutboundAdapter(payload, { weixin, telegram, qqbot }).sendText(payload);
    },
    sendTyping(payload = {}) {
      return resolveOutboundAdapter(payload, { weixin, telegram, qqbot }).sendTyping(payload);
    },
    sendFile(payload = {}) {
      return resolveOutboundAdapter(payload, { weixin, telegram, qqbot }).sendFile(payload);
    },
    setMinChunkChars: (...args) => weixin.setMinChunkChars(...args),
    getMinChunkChars: (...args) => weixin.getMinChunkChars(...args),
  };
}

function resolveOutboundAdapter(payload, adapters) {
  const provider = String(payload?.provider || "").trim().toLowerCase();
  const contextToken = String(payload?.contextToken || "").trim().toLowerCase();
  if (provider === "qqbot" || contextToken.startsWith("qqbot:")) return adapters.qqbot;
  if (provider === "telegram" || contextToken.startsWith("telegram:")) return adapters.telegram;
  return adapters.weixin;
}

module.exports = { createChannelRouter };
