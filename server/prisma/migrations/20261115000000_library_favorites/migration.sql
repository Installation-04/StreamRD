-- Additive: a viewer's own list ("My List") of library titles. An entry names a title by its owner and its group, so all versions of
-- a title share one entry. Nothing existing is changed; the table starts empty.
BEGIN IMMEDIATE;
CREATE TABLE "LibraryFavorite" (
    "userId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "groupKey" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY ("userId", "ownerId", "groupKey"),
    CONSTRAINT "LibraryFavorite_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "LibraryFavorite_userId_createdAt_idx" ON "LibraryFavorite"("userId", "createdAt");
COMMIT;
