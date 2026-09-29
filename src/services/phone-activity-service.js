const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { URL } = require("url");

const MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_HISTORY_LIMIT = 300;
const STALE_CURRENT_MS = 4 * 60 * 60 * 1000;

class PhoneActivityService {
  constructor({ config = {} } = {}) {
    this.filePath = String(config.phoneActivityFile || "").trim();
    this.host = String(config.phoneActivityHost || "0.0.0.0").trim() || "0.0.0.0";
    this.port = normalizePositiveInt(config.phoneActivityPort, 4319);
    this.token = String(config.phoneActivityToken || "").trim();
    this.historyLimit = normalizePositiveInt(config.phoneActivityHistoryLimit, DEFAULT_HISTORY_LIMIT);
    this.server = null;
  }

  ingest(payload = {}, metadata = {}) {
    const appName = normalizeText(payload.appName || payload.app || payload.name);
    const eventType = normalizeEventType(payload.event || payload.state || payload.action);
    if (!appName) {
      throw new Error("appName is required");
    }
    if (!eventType) {
      throw new Error("event must be open or close");
    }

    const receivedAt = new Date().toISOString();
    const occurredAt = normalizeTimestamp(payload.timestamp || payload.capturedAt, receivedAt);
    const state = this.readState();
    const event = {
      id: crypto.randomUUID(),
      appName,
      event: eventType,
      occurredAt,
      receivedAt,
      source: normalizeText(payload.source) || "shortcuts",
      trigger: normalizeText(payload.trigger),
      batteryLevel: normalizeBatteryLevel(payload.batteryLevel),
      remoteAddress: normalizeText(metadata.remoteAddress),
      userAgent: normalizeText(metadata.userAgent),
    };

    if (eventType === "open") {
      if (state.current && state.current.appName !== appName) {
        state.sessions.push(buildSession(state.current, occurredAt, "inferred_switch"));
      }
      if (!state.current || state.current.appName !== appName) {
        state.current = {
          appName,
          openedAt: occurredAt,
          lastEventAt: occurredAt,
          source: event.source,
          batteryLevel: event.batteryLevel,
        };
      } else {
        state.current.lastEventAt = occurredAt;
        state.current.batteryLevel = event.batteryLevel ?? state.current.batteryLevel;
      }
    } else if (state.current?.appName === appName) {
      state.sessions.push(buildSession(state.current, occurredAt, "reported_close"));
      state.current = null;
    }

    state.events.push(event);
    state.events = state.events.slice(-this.historyLimit);
    state.sessions = state.sessions.slice(-this.historyLimit);
    state.updatedAt = receivedAt;
    this.writeState(state);
    return { event, snapshot: buildSnapshot(state) };
  }

  snapshot() {
    return buildSnapshot(this.readState());
  }

  async startServer({ onAccepted = null } = {}) {
    if (this.server) {
      return this.server;
    }
    if (!this.token) {
      throw new Error("CYBERBOSS_PHONE_ACTIVITY_TOKEN is required");
    }
    const acceptedCallback = typeof onAccepted === "function" ? onAccepted : null;
    this.server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url || "/", "http://localhost");
        if (req.method === "GET" && url.pathname === "/phone-activity/healthz") {
          writeJson(res, 200, { ok: true });
          return;
        }
        if (req.method === "POST" && url.pathname === "/phone-activity/ingest") {
          if (!isAuthorized(req.headers.authorization, this.token)) {
            writeJson(res, 401, { error: "unauthorized" });
            return;
          }
          const bodyText = await readRawBody(req);
          const payload = parseJsonObject(bodyText);
          const result = this.ingest(payload, {
            remoteAddress: extractRemoteAddress(req),
            userAgent: req.headers["user-agent"] || "",
          });
          if (acceptedCallback) {
            Promise.resolve(acceptedCallback(result)).catch(() => {});
          }
          writeJson(res, 202, {
            ok: true,
            id: result.event.id,
            appName: result.event.appName,
            event: result.event.event,
            occurredAt: result.event.occurredAt,
          });
          return;
        }
        writeJson(res, 404, { error: "not_found" });
      } catch (error) {
        writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
      }
    });
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.port, this.host, resolve);
    });
    return this.server;
  }

  async closeServer() {
    if (!this.server) {
      return;
    }
    const server = this.server;
    this.server = null;
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  readState() {
    if (!this.filePath || !fs.existsSync(this.filePath)) {
      return emptyState();
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      return {
        version: 1,
        updatedAt: normalizeText(parsed?.updatedAt),
        current: parsed?.current && typeof parsed.current === "object" ? parsed.current : null,
        events: Array.isArray(parsed?.events) ? parsed.events : [],
        sessions: Array.isArray(parsed?.sessions) ? parsed.sessions : [],
      };
    } catch {
      return emptyState();
    }
  }

  writeState(state) {
    if (!this.filePath) {
      throw new Error("phone activity state file is not configured");
    }
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }
}

function emptyState() {
  return { version: 1, updatedAt: "", current: null, events: [], sessions: [] };
}

function buildSession(current, closedAt, closeReason) {
  const openedAtMs = Date.parse(current.openedAt);
  const closedAtMs = Date.parse(closedAt);
  return {
    id: crypto.randomUUID(),
    appName: current.appName,
    openedAt: current.openedAt,
    closedAt,
    durationSeconds: Number.isFinite(openedAtMs) && Number.isFinite(closedAtMs)
      ? Math.max(0, Math.round((closedAtMs - openedAtMs) / 1000))
      : 0,
    closeReason,
  };
}

function buildSnapshot(state, now = new Date()) {
  const nowMs = now.getTime();
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const totals = new Map();
  for (const session of state.sessions || []) {
    const closedAtMs = Date.parse(session.closedAt);
    if (!Number.isFinite(closedAtMs) || closedAtMs < dayStart) {
      continue;
    }
    totals.set(session.appName, (totals.get(session.appName) || 0) + normalizeDuration(session.durationSeconds));
  }

  let current = null;
  if (state.current) {
    const openedAtMs = Date.parse(state.current.openedAt);
    const lastEventAtMs = Date.parse(state.current.lastEventAt || state.current.openedAt);
    const durationSeconds = Number.isFinite(openedAtMs)
      ? Math.max(0, Math.round((nowMs - openedAtMs) / 1000))
      : 0;
    const stale = !Number.isFinite(lastEventAtMs) || nowMs - lastEventAtMs > STALE_CURRENT_MS;
    current = { ...state.current, durationSeconds, stale };
    if (!stale) {
      totals.set(current.appName, (totals.get(current.appName) || 0) + durationSeconds);
    }
  }

  return {
    updatedAt: state.updatedAt || "",
    current,
    today: [...totals.entries()]
      .map(([appName, durationSeconds]) => ({ appName, durationSeconds }))
      .sort((a, b) => b.durationSeconds - a.durationSeconds),
    recentEvents: [...(state.events || [])].slice(-12).reverse(),
    recentSessions: [...(state.sessions || [])].slice(-12).reverse(),
  };
}

function formatPhoneActivityContext(filePath, now = new Date()) {
  const service = new PhoneActivityService({ config: { phoneActivityFile: filePath } });
  const snapshot = service.snapshot();
  if (!snapshot.updatedAt && !snapshot.current && !snapshot.recentEvents.length) {
    return "";
  }
  const lines = [];
  if (snapshot.current) {
    const minutes = Math.max(1, Math.round(snapshot.current.durationSeconds / 60));
    lines.push(snapshot.current.stale
      ? `最后一个未闭合的 App 记录是 ${snapshot.current.appName}，已过 ${minutes} 分钟，当前是否仍在使用无法确认。`
      : `当前上报的 App 是 ${snapshot.current.appName}，已打开约 ${minutes} 分钟。`);
  } else {
    const latest = snapshot.recentEvents[0];
    if (latest) {
      lines.push(`当前没有未闭合 App；最近信号是 ${latest.appName} ${latest.event === "open" ? "打开" : "关闭"}。`);
    }
  }
  if (snapshot.today.length) {
    lines.push(`今日已追踪：${snapshot.today.slice(0, 8).map((item) => `${item.appName} ${formatDuration(item.durationSeconds)}`).join("，")}。`);
  }
  lines.push("这里只覆盖已配置自动化的 App；缺少关闭信号时不要把未闭合记录当成确定的实时状态。");
  return lines.join("\n");
}

function parseJsonObject(bodyText) {
  if (!String(bodyText || "").trim()) {
    throw new Error("missing request body");
  }
  let parsed;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    throw new Error("request body must be valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("request body must be a JSON object");
  }
  return parsed;
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8").trim()));
    req.on("error", reject);
  });
}

function isAuthorized(authorization, token) {
  const header = normalizeText(authorization);
  return Boolean(token) && header.startsWith("Bearer ") && header.slice(7).trim() === token;
}

function extractRemoteAddress(req) {
  return normalizeText(String(req.headers["x-forwarded-for"] || "").split(",")[0])
    || normalizeText(req.socket?.remoteAddress);
}

function writeJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body, "utf8"),
  });
  res.end(body);
}

function normalizeEventType(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (["open", "opened", "start"].includes(normalized)) {
    return "open";
  }
  if (["close", "closed", "stop"].includes(normalized)) {
    return "close";
  }
  return "";
}

function normalizeTimestamp(value, fallback) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
}

function normalizeBatteryLevel(value) {
  if (value === "" || value == null) {
    return null;
  }
  const numeric = Math.round(Number(value));
  return Number.isFinite(numeric) && numeric >= 0 && numeric <= 100 ? numeric : null;
}

function normalizePositiveInt(value, fallback) {
  const numeric = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

function normalizeDuration(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.round(numeric) : 0;
}

function normalizeText(value) {
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value).trim();
  }
  if (Array.isArray(value)) {
    const items = value.map((item) => normalizeText(item)).filter(Boolean);
    return items.length === 1 ? items[0] : items.join("|");
  }
  if (value && typeof value === "object") {
    for (const key of ["value", "Value", "text", "Text", "name", "Name"]) {
      const normalized = normalizeText(value[key]);
      if (normalized) {
        return normalized;
      }
    }
  }
  return "";
}

function formatDuration(seconds) {
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) {
    return `${minutes} 分钟`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} 小时 ${rest} 分` : `${hours} 小时`;
}

module.exports = {
  PhoneActivityService,
  buildSnapshot,
  formatPhoneActivityContext,
};
