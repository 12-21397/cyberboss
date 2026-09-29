const { stopSharedProcesses } = require("./shared-common");

async function main() {
  const stopped = await stopSharedProcesses();
  if (!stopped.length) {
    console.log("shared Cyberboss is already stopped");
    return;
  }
  for (const process of stopped) {
    console.log(`stopped ${process.name} pid=${process.pid}`);
  }
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exit(1);
});
