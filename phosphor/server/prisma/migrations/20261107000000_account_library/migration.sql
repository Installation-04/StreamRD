-- Private account imports and recoverable read-only provider scanning.
BEGIN IMMEDIATE;
ALTER TABLE "DebridConfig" ADD COLUMN "autoImportLibrary" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "MetadataRecord" ADD COLUMN "ownerId" TEXT REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "MetadataRecord_ownerId_idx" ON "MetadataRecord"("ownerId");
CREATE TABLE "AccountMedia" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "userId" TEXT NOT NULL,
 "provider" TEXT NOT NULL,
 "providerRef" TEXT NOT NULL,
 "credentialFingerprint" TEXT NOT NULL,
 "name" TEXT NOT NULL,
 "type" TEXT NOT NULL DEFAULT 'movie',
 "year" INTEGER,
 "phase" TEXT NOT NULL,
 "progress" INTEGER NOT NULL DEFAULT 0,
 "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" DATETIME NOT NULL,
 CONSTRAINT "AccountMedia_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "AccountMedia_userId_provider_providerRef_key" ON "AccountMedia"("userId", "provider", "providerRef");
CREATE INDEX "AccountMedia_userId_createdAt_id_idx" ON "AccountMedia"("userId", "createdAt", "id");
CREATE TABLE "AccountScan" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "userId" TEXT NOT NULL,
 "provider" TEXT NOT NULL,
 "status" TEXT NOT NULL DEFAULT 'queued',
 "cursor" TEXT,
 "credentialFingerprint" TEXT NOT NULL,
 "automatic" BOOLEAN NOT NULL DEFAULT true,
 "revision" INTEGER NOT NULL DEFAULT 0,
 "leaseUntil" DATETIME,
 "nextAttemptAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "failures" INTEGER NOT NULL DEFAULT 0,
 "pages" INTEGER NOT NULL DEFAULT 0,
 "scanned" INTEGER NOT NULL DEFAULT 0,
 "imported" INTEGER NOT NULL DEFAULT 0,
 "skipped" INTEGER NOT NULL DEFAULT 0,
 "error" TEXT,
 "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" DATETIME NOT NULL,
 CONSTRAINT "AccountScan_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "AccountScan_userId_provider_key" ON "AccountScan"("userId", "provider");
CREATE INDEX "AccountScan_status_nextAttemptAt_idx" ON "AccountScan"("status", "nextAttemptAt");
COMMIT;
