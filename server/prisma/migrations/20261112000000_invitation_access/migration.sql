-- Additive: an invitation can carry library access and a viewing limit that are applied to the account it creates.
-- Existing invitations keep no access (an empty list and no limit), so they behave exactly as before.
BEGIN IMMEDIATE;
ALTER TABLE "Invitation" ADD COLUMN "libraryIds" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "Invitation" ADD COLUMN "maxAge" INTEGER;
COMMIT;
