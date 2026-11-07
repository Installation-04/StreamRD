import { queueImportedMetadata } from "./metadata/account";
import { setAccountImportHook, startAccountLibraryWorker } from "./account-library";
import { startMetadataWorker } from "./metadata/automation";
import { createApp } from "./app";
import { config } from "./config";
import { db } from "./db";
import { logEvent } from "./logger";

async function main() {
  if (config.adminEmail) {
    await db.user.updateMany({
      where: { email: config.adminEmail.toLowerCase(), role: "user" },
      data: { role: "admin" },
    });
  }
  const app = createApp();
  app.listen(config.port, () => {
    setAccountImportHook(queueImportedMetadata);
    startAccountLibraryWorker();
    startMetadataWorker();
    void logEvent("info", "system", `Phosphor server listening on :${config.port}`);
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Fatal startup error", err);
  process.exit(1);
});
