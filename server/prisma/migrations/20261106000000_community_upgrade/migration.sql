-- Explicit SQLite transaction: a failed statement must not leave partial application tables.
BEGIN IMMEDIATE;

-- CreateTable
CREATE TABLE "PlaybackSourceJob" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerRef" TEXT,
    "expiresAt" DATETIME NOT NULL,
    "leaseUntil" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PlaybackSourceJob_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PlaybackSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "profileId" TEXT,
    "scope" TEXT NOT NULL DEFAULT '',
    "titleId" TEXT NOT NULL,
    "mediaKey" TEXT NOT NULL,
    "lastSequence" INTEGER NOT NULL DEFAULT -1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL,
    CONSTRAINT "PlaybackSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PlaybackSession_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PlaybackSession_titleId_fkey" FOREIGN KEY ("titleId") REFERENCES "Title" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PlaybackProgress" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "profileId" TEXT,
    "scope" TEXT NOT NULL DEFAULT '',
    "titleId" TEXT NOT NULL,
    "mediaKey" TEXT NOT NULL,
    "positionSeconds" REAL NOT NULL DEFAULT 0,
    "durationSeconds" REAL NOT NULL DEFAULT 0,
    "completed" BOOLEAN NOT NULL DEFAULT false,
    "activeSessionId" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PlaybackProgress_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PlaybackProgress_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PlaybackProgress_titleId_fkey" FOREIGN KEY ("titleId") REFERENCES "Title" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RevokedSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    CONSTRAINT "RevokedSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Add the only changed User field without rebuilding or dropping the parent table.
ALTER TABLE "User" ADD COLUMN "sessionVersion" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "PlaybackSourceJob_userId_idx" ON "PlaybackSourceJob"("userId");

-- CreateIndex
CREATE INDEX "PlaybackSourceJob_expiresAt_idx" ON "PlaybackSourceJob"("expiresAt");

-- CreateIndex
CREATE INDEX "PlaybackSession_userId_idx" ON "PlaybackSession"("userId");

-- CreateIndex
CREATE INDEX "PlaybackSession_expiresAt_idx" ON "PlaybackSession"("expiresAt");

-- CreateIndex
CREATE INDEX "PlaybackProgress_userId_scope_completed_updatedAt_id_idx" ON "PlaybackProgress"("userId", "scope", "completed", "updatedAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PlaybackProgress_userId_scope_titleId_mediaKey_key" ON "PlaybackProgress"("userId", "scope", "titleId", "mediaKey");

-- CreateIndex
CREATE INDEX "RevokedSession_expiresAt_idx" ON "RevokedSession"("expiresAt");

-- CreateIndex
CREATE INDEX "Title_createdAt_id_idx" ON "Title"("createdAt", "id");

-- CreateIndex
CREATE INDEX "Title_type_createdAt_id_idx" ON "Title"("type", "createdAt", "id");

-- CreateIndex
CREATE INDEX "Favorite_userId_createdAt_id_idx" ON "Favorite"("userId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "PlaybackLog_userId_success_titleId_createdAt_idx" ON "PlaybackLog"("userId", "success", "titleId", "createdAt");


COMMIT;
