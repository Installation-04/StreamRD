import { startRequestWorker } from "./requests/worker";
import { startAutomaticApprovals } from "./requests/approval";
import { startProwlarr } from "./prowlarr";
import { queueImportedMetadata } from "./metadata/account";
import { setAccountImportHook, startAccountLibraryWorker } from "./account-library";
import { startMetadataWorker } from "./metadata/automation";
import { startLinkHealthWorker } from "./link-health";
import { ensureZileanIndexer } from "./indexers/zilean";
import { createApp } from "./app";
import { backfillRatings } from "./ratings";
import { backfillGroups } from "./versions";
import { config } from "./config";
import { db, enableWal, encryptStoredSecrets } from "./db";
import { logEvent } from "./logger";
import { recordUpdateOutcomeWhenKnown } from "./routes/logs";
import { settleRegistrationDefault } from "./auth/access";
import { loadRuntimeSettings } from "./runtime-settings";

async function main() {
  await enableWal();
  const encrypted = await encryptStoredSecrets();
  if (encrypted) void logEvent("info", "system", `Encrypted ${encrypted} stored credential${encrypted === 1 ? "" : "s"} at rest`);
  if (config.adminEmail) {
    await db.user.updateMany({
      where: { email: config.adminEmail.toLowerCase(), role: "user" },
      data: { role: "admin" },
    });
  }
  await loadRuntimeSettings(); // choices saved in Admin → Server take the place of their environment variables
  const app = createApp();
  app.listen(config.port, () => {
    setAccountImportHook(queueImportedMetadata);
    startAccountLibraryWorker();
    startMetadataWorker();
    startLinkHealthWorker();
    void backfillRatings().catch(() => undefined); // ratings of titles matched before viewing limits existed
    void backfillGroups().catch(() => undefined); // names titles imported before versions existed
    startRequestWorker();
    startAutomaticApprovals();
    startProwlarr(); // Prowlarr, which finds releases for requests, is started by the Docker helper unless it was removed
    void ensureZileanIndexer().catch(() => undefined);
    void settleRegistrationDefault().then(notice => { if (notice) void logEvent("warn", "system", notice); }).catch(() => undefined);
    recordUpdateOutcomeWhenKnown(); // how the last update or rollback went, as the update helper recorded it
    void logEvent("info", "system", `Phosphor server listening on :${config.port}`);
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Fatal startup error", err);
  process.exit(1);
});
