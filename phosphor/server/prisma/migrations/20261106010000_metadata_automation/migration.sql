-- Durable metadata matching state and recoverable refresh leases.
BEGIN IMMEDIATE;

CREATE TABLE "MetadataRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mediaType" TEXT NOT NULL,
    "year" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "requestedBy" TEXT NOT NULL DEFAULT 'automatic',
    "data" TEXT NOT NULL DEFAULT '{}',
    "lockedFields" TEXT NOT NULL DEFAULT '[]',
    "revision" INTEGER NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseUntil" DATETIME,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE UNIQUE INDEX "MetadataRecord_targetType_targetId_key" ON "MetadataRecord"("targetType", "targetId");
CREATE INDEX "MetadataRecord_status_nextAttemptAt_idx" ON "MetadataRecord"("status", "nextAttemptAt");

COMMIT;
