const fs = require("fs");
const path = require("path");

class MemoryArchive {
  constructor({ archiveDir } = {}) {
    this.archiveDir = archiveDir || "";
    if (this.archiveDir) {
      fs.mkdirSync(this.archiveDir, { recursive: true });
    }
  }

  archiveMessage(message) {
    if (!this.archiveDir || !message || typeof message !== "object") {
      return;
    }
    const dateKey = this._dateKey(message.timestamp || message.receivedAt || message.createdAt);
    const filePath = path.join(this.archiveDir, `${dateKey}.jsonl`);
    try {
      fs.appendFileSync(filePath, `${JSON.stringify(message)}\n`, "utf8");
    } catch (error) {
      console.error(`[memory-archive] write error: ${error.message}`);
    }
  }

  archiveMessages(messages) {
    const list = Array.isArray(messages) ? messages : [messages];
    const grouped = new Map();
    for (const message of list) {
      if (!message || typeof message !== "object") {
        continue;
      }
      const dateKey = this._dateKey(message.timestamp || message.receivedAt || message.createdAt);
      if (!grouped.has(dateKey)) {
        grouped.set(dateKey, []);
      }
      grouped.get(dateKey).push(message);
    }

    for (const [dateKey, batch] of grouped) {
      const filePath = path.join(this.archiveDir, `${dateKey}.jsonl`);
      const lines = batch.map((message) => `${JSON.stringify(message)}\n`).join("");
      try {
        fs.appendFileSync(filePath, lines, "utf8");
      } catch (error) {
        console.error(`[memory-archive] batch write error: ${error.message}`);
      }
    }
  }

  readDay(dateString) {
    const filePath = path.join(this.archiveDir, `${dateString}.jsonl`);
    try {
      return fs.readFileSync(filePath, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  readRecent(count = 100) {
    const files = this._listArchiveFiles().sort().reverse();
    const results = [];
    for (const file of files) {
      if (results.length >= count) {
        break;
      }
      const entries = this.readDay(file.replace(/\.jsonl$/i, ""));
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        if (results.length >= count) {
          break;
        }
        results.unshift(entries[index]);
      }
    }
    return results;
  }

  readRecentHours(hours = 1) {
    const cutoff = Date.now() - hours * 3600 * 1000;
    const files = this._listArchiveFiles().sort().reverse();
    const results = [];
    for (const file of files) {
      const dateString = file.replace(/\.jsonl$/i, "");
      if (this._dateToMs(dateString) < cutoff - 86400000) {
        break;
      }
      const entries = this.readDay(dateString);
      for (const entry of entries) {
        const timestampMs = new Date(entry.timestamp || entry.receivedAt || entry.createdAt).getTime();
        if (timestampMs >= cutoff) {
          results.push(entry);
        }
      }
    }
    return results;
  }

  _listArchiveFiles() {
    try {
      return fs.readdirSync(this.archiveDir).filter((file) => file.endsWith(".jsonl"));
    } catch {
      return [];
    }
  }

  _dateKey(timestamp) {
    if (!timestamp) {
      return this._todayKey();
    }
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) {
      return this._todayKey();
    }
    return date.toISOString().slice(0, 10);
  }

  _todayKey() {
    return new Date().toISOString().slice(0, 10);
  }

  _dateToMs(dateString) {
    return new Date(`${dateString}T00:00:00Z`).getTime();
  }
}

module.exports = { MemoryArchive };
