-- Additive: an optional viewing limit per user (null = no limit) and a rating per imported title. Existing rows are unchanged
-- (every title starts unrated; ratings are filled in from stored metadata when the server starts).
BEGIN IMMEDIATE;
ALTER TABLE "User" ADD COLUMN "maxAge" INTEGER;
ALTER TABLE "AccountMedia" ADD COLUMN "ratingOverride" TEXT;
ALTER TABLE "AccountMedia" ADD COLUMN "ratingLabel" TEXT;
ALTER TABLE "AccountMedia" ADD COLUMN "minAge" INTEGER;
COMMIT;
