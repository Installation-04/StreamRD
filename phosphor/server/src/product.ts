/**
 * The only product-specific values that otherwise-shared source files need. Files listed in
 * shared-manifest.json are identical in StreamRD and Phosphor (see CONTRIBUTING.md), so anything that
 * differs between the products belongs here, not in them.
 */
export const PRODUCT = {
  id: "phosphor",
  /** Name of the browser session cookie. */
  sessionCookie: "ph_token",
  /** Context string for deriving the credential-encryption key when no explicit key is set. */
  dataKeyInfo: "phosphor-data-v1",
  /** Credential columns encrypted at rest, by Prisma model (see db.ts). */
  secretFields: { debridConfig: ["realDebridToken", "allDebridApiKey", "premiumizeApiKey", "torboxApiKey"], indexerConfig: ["apiKey"] } as Record<string, string[]>,
} as const;
