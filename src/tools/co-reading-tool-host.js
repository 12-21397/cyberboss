const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const TOOL_NAMES = [
  "reading_import_book",
  "reading_list_books",
  "reading_get_manifest",
  "reading_search",
  "reading_search_exact",
  "reading_get_chunk",
  "reading_get_progress",
  "reading_build_index",
  "reading_update_progress",
  "reading_update_note",
  "reading_read_note",
  "reading_resume_book",
  "reading_link_weread_book",
  "reading_find_weread_context",
];

const TOOL_DESCRIPTIONS = {
  reading_import_book: "Import a local EPUB/TXT/Markdown file into the Cyberboss reading library.",
  reading_list_books: "List imported local books from the Cyberboss reading library.",
  reading_get_manifest: "Read one book manifest without loading full source text.",
  reading_search: "Search reading chunks by keyword in one book or across all books.",
  reading_search_exact: "Search reading chunks by exact phrase in one book or across all books.",
  reading_get_chunk: "Read exactly one chunk from a book by chunkId or path.",
  reading_get_progress: "Read reading progress for one book or all books.",
  reading_build_index: "Build search index for one book or all imported books.",
  reading_update_progress: "Update reading progress for a book.",
  reading_update_note: "Update long-term reading notes for a book.",
  reading_read_note: "Read fixed sections from reading notes for a book.",
  reading_resume_book: "Resume reading by returning progress, note sections, and optionally one chunk.",
  reading_link_weread_book: "Link a WeRead book to a local imported book.",
  reading_find_weread_context: "Resolve a WeRead highlight to local chunk context.",
};

class CoReadingToolHost {
  constructor({ config } = {}) {
    this.config = config || {};
    this.projectRoot = path.resolve(__dirname, "..", "..");
    this.packageRoot = path.join(this.projectRoot, "tools", "co-reading-kit");
    this.serverPath = path.join(this.packageRoot, "src", "mcp-server.js");
  }

  isAvailable() {
    return fs.existsSync(this.serverPath);
  }

  listTools() {
    if (!this.isAvailable()) {
      return [];
    }
    return TOOL_NAMES.map((name) => ({
      name,
      description: TOOL_DESCRIPTIONS[name] || name,
      inputSchema: {
        type: "object",
        additionalProperties: true,
      },
    }));
  }

  async invokeTool(toolName, args = {}) {
    if (!TOOL_NAMES.includes(toolName)) {
      throw new Error(`Unknown co-reading tool: ${toolName}`);
    }
    if (!this.isAvailable()) {
      throw new Error(`co-reading-kit is not installed: ${this.serverPath}`);
    }
    return await callMcpTool({
      command: process.execPath,
      args: [this.serverPath],
      cwd: this.packageRoot,
      env: {
        READING_STATE_DIR: this.config.stateDir,
        CYBERBOSS_STATE_DIR: this.config.stateDir,
      },
      toolName,
      toolArgs: args && typeof args === "object" ? args : {},
    });
  }
}

async function callMcpTool({ command, args, cwd, env, toolName, toolArgs }) {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  const reader = createMcpReader(child.stdout);
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk || "");
  });

  try {
    await sendRequest(child, reader, 1, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "cyberboss-tools", version: "0.1.0" },
    });
    writeMcpMessage(child.stdin, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    });
    const result = await sendRequest(child, reader, 2, "tools/call", {
      name: toolName,
      arguments: toolArgs,
    });
    return normalizeMcpToolResult(result);
  } finally {
    child.kill();
  }

  function normalizeMcpToolResult(result) {
    const payload = result?.result || {};
    const content = Array.isArray(payload.content) ? payload.content : [];
    const text = content
      .map((item) => item?.type === "text" ? String(item.text || "") : "")
      .filter(Boolean)
      .join("\n")
      .trim();
    return {
      text: text || (payload.isError ? "co-reading tool failed" : "co-reading tool completed"),
      data: {
        isError: Boolean(payload.isError),
        structuredContent: payload.structuredContent || null,
        stderr: stderr.trim(),
      },
    };
  }
}

function sendRequest(child, reader, id, method, params) {
  writeMcpMessage(child.stdin, {
    jsonrpc: "2.0",
    id,
    method,
    params,
  });
  return reader.waitForResponse(id, 30_000);
}

function createMcpReader(stream) {
  let buffer = Buffer.alloc(0);
  const pending = new Map();

  stream.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
    while (true) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).toString("utf8").trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line) {
          emitMessage(line, pending);
        }
        continue;
      }

      const headerEnd = buffer.indexOf("\r\n\r\n");
      const altHeaderEnd = headerEnd < 0 ? buffer.indexOf("\n\n") : -1;
      const boundary = headerEnd >= 0 ? headerEnd : altHeaderEnd;
      if (boundary < 0) {
        return;
      }
      const separatorLength = headerEnd >= 0 ? 4 : 2;
      const headerText = buffer.slice(0, boundary).toString("utf8");
      const lengthMatch = headerText.match(/Content-Length:\s*(\d+)/i);
      if (!lengthMatch) {
        buffer = Buffer.alloc(0);
        return;
      }
      const length = Number.parseInt(lengthMatch[1], 10);
      const bodyStart = boundary + separatorLength;
      if (buffer.length < bodyStart + length) {
        return;
      }
      const body = buffer.slice(bodyStart, bodyStart + length).toString("utf8");
      buffer = buffer.slice(bodyStart + length);
      emitMessage(body, pending);
    }
  });

  return {
    waitForResponse(id, timeoutMs) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`co-reading MCP request timed out: ${id}`));
        }, timeoutMs);
        pending.set(id, {
          resolve(message) {
            clearTimeout(timer);
            if (message.error) {
              reject(new Error(message.error.message || "co-reading MCP error"));
              return;
            }
            resolve(message);
          },
        });
      });
    },
  };
}

function emitMessage(body, pending) {
  let message = null;
  try {
    message = JSON.parse(body);
  } catch {
    return;
  }
  const entry = pending.get(message.id);
  if (entry) {
    pending.delete(message.id);
    entry.resolve(message);
  }
}

function writeMcpMessage(stream, payload) {
  stream.write(`${JSON.stringify(payload)}\n`);
}

module.exports = { CoReadingToolHost };
