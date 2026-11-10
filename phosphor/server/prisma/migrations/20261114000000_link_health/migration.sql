-- Additive: link health. A background check records whether the provider still serves each finished import (health: unknown, ok or
-- broken, with the time of the last check and a count of consecutive failures). Existing rows start as unknown and are checked in the
-- background; nothing is removed or rewritten.
BEGIN IMMEDIATE;
ALTER TABLE "AccountMedia" ADD COLUMN "health" TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE "AccountMedia" ADD COLUMN "healthCheckedAt" DATETIME;
ALTER TABLE "AccountMedia" ADD COLUMN "healthFailures" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "AccountMedia" ADD COLUMN "healthError" TEXT;
CREATE INDEX "AccountMedia_health_healthCheckedAt_idx" ON "AccountMedia"("health", "healthCheckedAt");
COMMIT;
