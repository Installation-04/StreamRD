import { startRequestWorker } from "./requests/worker";
import { queueImportedMetadata } from "./metadata/account";
import { setAccountImportHook, startAccountLibraryWorker } from "./account-library";
import { startMetadataWorker } from "./metadata/automation";
import { createApp } from "./app";
import { backfillRatings } from "./ratings";
import { backfillGroups } from "./versions";
import { config } from "./config";
import { db, enableWal, encryptStoredSecrets } from "./db";
import { logEvent } from "./logger";

async function main() {
  await enableWal();
  const encrypted = await encryptStoredSecrets();
  if (encrypted) void logEvent("info", "system", `Encrypted ${encrypted} stored credential${encrypted === 1 ? "" : "s"} at rest`);
  // Promote the configured admin email if that account already exists.
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
    void backfillRatings().catch(() => undefined); // ratings of titles matched before viewing limits existed
    void backfillGroups().catch(() => undefined); // names titles imported before versions existed
    startRequestWorker();
    void logEvent("info", "system", `StreamRD server listening on :${config.port}`);
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Fatal startup error", err);
  process.exit(1);
});
