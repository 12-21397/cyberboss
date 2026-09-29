const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");

const projectRoot = path.resolve(__dirname, "..");
for (const fileName of [".env", ".env.telegram", ".env.qqbot", ".env.elevenlabs"]) {
  const filePath = path.join(projectRoot, fileName);
  if (fs.existsSync(filePath)) {
    dotenv.config({ path: filePath });
  }
}

const { createChannelRouter } = require("../src/adapters/channel");
const { readConfig } = require("../src/core/config");

async function main() {
  const contextToken = String(process.argv[2] || "").trim();
  const filePath = path.resolve(String(process.argv[3] || "").trim());
  if (!contextToken || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error("Usage: node scripts/send-channel-file.js <contextToken> <filePath>");
  }
  const channel = createChannelRouter(readConfig());
  await channel.sendFile({ contextToken, filePath });
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(error.message || String(error));
  process.exit(1);
});
