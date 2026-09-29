const fs = require("fs");
const path = require("path");

let cachedKey = null;
let cachedPlugins = [];

function loadExternalToolPlugins() {
  const pluginRoot = path.resolve(__dirname, "..", "..", "plugins");
  const configured = splitPluginPaths(process.env.CYBERBOSS_PROJECT_TOOL_PLUGINS);
  const discovered = discoverPluginDirectories(pluginRoot);
  const paths = [...new Set([...discovered, ...configured].map((item) => path.resolve(item)))];
  const key = paths.join("\n");
  if (key === cachedKey) return cachedPlugins;
  cachedKey = key;
  cachedPlugins = paths.map(loadPlugin);
  return cachedPlugins;
}

function discoverPluginDirectories(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name))
    .filter((dir) => fs.existsSync(path.join(dir, "cyberboss.plugin.json")));
}

function splitPluginPaths(value) {
  return String(value || "")
    .split(new RegExp(`[${escapeRegExp(path.delimiter)},]`))
    .map((item) => item.trim())
    .filter(Boolean);
}

function loadPlugin(pluginDir) {
  const manifestPath = path.join(pluginDir, "cyberboss.plugin.json");
  if (!fs.existsSync(manifestPath)) throw new Error(`Cyberboss plugin manifest not found: ${manifestPath}`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.kind !== "project-tool-host") throw new Error(`Unsupported Cyberboss plugin kind in ${manifestPath}`);
  const entryPath = path.resolve(pluginDir, manifest.entry || "index.js");
  const loaded = require(entryPath);
  const ToolHost = loaded.ToolHost || loaded.ThreadBridgeToolHost;
  const toolNames = loaded.toolNames || loaded.THREAD_BRIDGE_TOOL_NAMES || [];
  if (typeof ToolHost !== "function") throw new Error(`Cyberboss plugin does not export ToolHost: ${entryPath}`);
  return { id: manifest.id || path.basename(pluginDir), pluginDir, ToolHost, toolNames };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = { loadExternalToolPlugins, discoverPluginDirectories, splitPluginPaths };
