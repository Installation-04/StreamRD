-- Additive per-viewer resume positions for shared imports; existing rows are unchanged.
BEGIN IMMEDIATE;
CREATE TABLE "SharedLibraryProgress" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "userId" TEXT NOT NULL,
 "itemId" TEXT NOT NULL,
 "mediaKey" TEXT NOT NULL,
 "positionSeconds" REAL NOT NULL DEFAULT 0,
 "durationSeconds" REAL NOT NULL DEFAULT 0,
 "completed" BOOLEAN NOT NULL DEFAULT false,
 "activeSessionId" TEXT NOT NULL,
 "lastSequence" INTEGER NOT NULL DEFAULT -1,
 "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "SharedLibraryProgress_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 CONSTRAINT "SharedLibraryProgress_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "AccountMedia"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "SharedLibraryProgress_userId_itemId_mediaKey_key" ON "SharedLibraryProgress"("userId", "itemId", "mediaKey");
CREATE INDEX "SharedLibraryProgress_userId_completed_updatedAt_id_idx" ON "SharedLibraryProgress"("userId", "completed", "updatedAt", "id");
CREATE INDEX "SharedLibraryProgress_itemId_idx" ON "SharedLibraryProgress"("itemId");
COMMIT;
