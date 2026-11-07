-- Additive server invitations and explicit sharing; existing imports and accounts are unchanged.
BEGIN IMMEDIATE;
CREATE TABLE "Invitation" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "tokenHash" TEXT NOT NULL,
 "email" TEXT NOT NULL,
 "createdById" TEXT NOT NULL,
 "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "expiresAt" DATETIME NOT NULL,
 "acceptedAt" DATETIME,
 "revokedAt" DATETIME
);
CREATE UNIQUE INDEX "Invitation_tokenHash_key" ON "Invitation"("tokenHash");
CREATE INDEX "Invitation_email_createdAt_idx" ON "Invitation"("email", "createdAt");
CREATE INDEX "Invitation_expiresAt_idx" ON "Invitation"("expiresAt");
CREATE TABLE "SharedLibrary" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "name" TEXT NOT NULL,
 "sourceUserId" TEXT NOT NULL,
 "mediaType" TEXT NOT NULL DEFAULT 'all',
 "enabled" BOOLEAN NOT NULL DEFAULT true,
 "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" DATETIME NOT NULL,
 CONSTRAINT "SharedLibrary_sourceUserId_fkey" FOREIGN KEY ("sourceUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "SharedLibrary_sourceUserId_createdAt_idx" ON "SharedLibrary"("sourceUserId", "createdAt");
CREATE TABLE "SharedLibraryGrant" (
 "libraryId" TEXT NOT NULL,
 "userId" TEXT NOT NULL,
 "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY ("libraryId", "userId"),
 CONSTRAINT "SharedLibraryGrant_libraryId_fkey" FOREIGN KEY ("libraryId") REFERENCES "SharedLibrary"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 CONSTRAINT "SharedLibraryGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "SharedLibraryGrant_userId_idx" ON "SharedLibraryGrant"("userId");
COMMIT;
