-- Additive: duplicates of one title (the same movie imported twice, several packs of one show) are grouped so a library shows one card
-- with several versions. groupKey names the title, isPrimary marks the version shown in lists, releaseName keeps the original release
-- name so versions can be told apart. Existing rows start with no group (shown as before) and are filled in when the server starts.
BEGIN IMMEDIATE;
ALTER TABLE "AccountMedia" ADD COLUMN "groupKey" TEXT;
ALTER TABLE "AccountMedia" ADD COLUMN "isPrimary" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "AccountMedia" ADD COLUMN "releaseName" TEXT;
CREATE INDEX "AccountMedia_userId_groupKey_idx" ON "AccountMedia"("userId", "groupKey");
COMMIT;
