-- Additive: a library can be visible to every active user. Existing libraries stay private to their grants.
BEGIN IMMEDIATE;
ALTER TABLE "SharedLibrary" ADD COLUMN "everyone" BOOLEAN NOT NULL DEFAULT false;
COMMIT;
