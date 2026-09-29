const fs = require("fs");
const path = require("path");

const { resolveSelectedAccount } = require("../adapters/channel/weixin/account-store");
const { loadPersistedContextTokens } = require("../adapters/channel/weixin/context-token-store");
const { resolvePreferredSenderId } = require("../core/default-targets");

class ChannelFileService {
  constructor({ config, channelAdapter, sessionStore }) {
    this.config = config;
    this.channelAdapter = channelAdapter;
    this.sessionStore = sessionStore;
  }

  async sendToCurrentChat({ filePath = "", userId = "" } = {}, context = {}) {
    const account = resolveSelectedAccount(this.config);
    const targetUserId = normalizeText(userId)
      || normalizeText(context?.senderId)
      || resolvePreferredSenderId({
        config: this.config,
        accountId: account.accountId,
        sessionStore: this.sessionStore,
      });
    if (!targetUserId) {
      throw new Error("Cannot determine which current-chat user should receive the file.");
    }

    const contextTokens = loadPersistedContextTokens(this.config, account.accountId);
    const contextToken = resolveCurrentChatContextToken({
      sessionStore: this.sessionStore,
      context,
      userId: targetUserId,
      fallbackContextToken: contextTokens[targetUserId],
    });
    if (!contextToken) {
      throw new Error(`Cannot find a context token for user ${targetUserId}. Let this user talk to the bot once first.`);
    }

    const requestedPath = normalizeText(filePath);
    if (!requestedPath) {
      throw new Error("Missing file path to send.");
    }
    const resolvedPath = path.resolve(requestedPath);
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`File does not exist: ${resolvedPath}`);
    }
    const stat = fs.statSync(resolvedPath);
    if (!stat.isFile()) {
      throw new Error(`Only files can be sent, not directories: ${resolvedPath}`);
    }

    await this.channelAdapter.sendTyping({
      userId: targetUserId,
      status: 1,
      contextToken,
    }).catch(() => {});
    await this.channelAdapter.sendFile({
      userId: targetUserId,
      filePath: resolvedPath,
      contextToken,
    });
    await this.channelAdapter.sendTyping({
      userId: targetUserId,
      status: 0,
      contextToken,
    }).catch(() => {});
    return { userId: targetUserId, filePath: resolvedPath };
  }
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function resolveCurrentChatContextToken({
  sessionStore = null,
  context = {},
  userId = "",
  fallbackContextToken = "",
} = {}) {
  const bindingKey = normalizeText(context?.bindingKey);
  const normalizedUserId = normalizeText(userId);
  if (bindingKey && typeof sessionStore?.getLastReplyTarget === "function") {
    const target = sessionStore.getLastReplyTarget(bindingKey);
    if (normalizeText(target?.userId) === normalizedUserId && normalizeText(target?.contextToken)) {
      return normalizeText(target.contextToken);
    }
  }
  return normalizeText(fallbackContextToken);
}

module.exports = { ChannelFileService, resolveCurrentChatContextToken };
