-- Canonical requests, private followers and a durable acquisition timeline.
BEGIN IMMEDIATE;
CREATE TABLE "MediaRequest" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "canonicalKey" TEXT NOT NULL,
 "provider" TEXT NOT NULL,
 "externalId" TEXT NOT NULL,
 "mediaType" TEXT NOT NULL,
 "name" TEXT NOT NULL,
 "year" INTEGER,
 "metadata" TEXT NOT NULL,
 "status" TEXT NOT NULL DEFAULT 'requested',
 "destination" TEXT,
 "sourceUserId" TEXT,
 "sharedLibraryId" TEXT,
 "sourceUrl" TEXT,
 "providerId" TEXT,
 "providerRef" TEXT,
 "sourceFingerprint" TEXT,
 "progress" INTEGER,
 "downloadState" TEXT,
 "error" TEXT,
 "revision" INTEGER NOT NULL DEFAULT 0,
 "attempts" INTEGER NOT NULL DEFAULT 0,
 "leaseUntil" DATETIME,
 "nextPollAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "startedAt" DATETIME,
 "downloadedAt" DATETIME,
 "availableAt" DATETIME,
 "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" DATETIME NOT NULL,
 CONSTRAINT "MediaRequest_sourceUserId_fkey" FOREIGN KEY ("sourceUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE,
 CONSTRAINT "MediaRequest_sharedLibraryId_fkey" FOREIGN KEY ("sharedLibraryId") REFERENCES "SharedLibrary"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "MediaRequest_canonicalKey_key" ON "MediaRequest"("canonicalKey");
CREATE INDEX "MediaRequest_status_nextPollAt_idx" ON "MediaRequest"("status", "nextPollAt");
CREATE INDEX "MediaRequest_sourceUserId_idx" ON "MediaRequest"("sourceUserId");
CREATE INDEX "MediaRequest_sharedLibraryId_idx" ON "MediaRequest"("sharedLibraryId");
CREATE TABLE "RequestFollower" (
 "requestId" TEXT NOT NULL,
 "userId" TEXT NOT NULL,
 "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY ("requestId", "userId"),
 CONSTRAINT "RequestFollower_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "MediaRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 CONSTRAINT "RequestFollower_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "RequestFollower_userId_createdAt_idx" ON "RequestFollower"("userId", "createdAt");
CREATE TABLE "RequestEvent" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "requestId" TEXT NOT NULL,
 "status" TEXT NOT NULL,
 "message" TEXT NOT NULL,
 "progress" INTEGER,
 "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "RequestEvent_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "MediaRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "RequestEvent_requestId_createdAt_idx" ON "RequestEvent"("requestId", "createdAt");
COMMIT;
