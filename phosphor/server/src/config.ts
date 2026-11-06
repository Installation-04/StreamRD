import { jwtSecretFor } from "./auth/secret";
const nodeEnv = process.env.NODE_ENV ?? "development";

/** Static process configuration read from environment variables. */
export const config = {
  port: parseInt(process.env.PORT ?? "61337", 10),
  jwtSecret: jwtSecretFor(nodeEnv, process.env.JWT_SECRET),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? "7d",
  apiBaseUrl: process.env.API_BASE_URL ?? "http://localhost:61337",
  lanUrl: process.env.LAN_URL ?? "",
  publicUrl: process.env.PUBLIC_URL ?? "",
  /** Comma-separated list of allowed CORS origins; "*" allows any. */
  corsOrigins: process.env.CORS_ORIGINS ?? "*",
  /** Users with this email are promoted to admin on signup/startup. */
  adminEmail: (process.env.ADMIN_EMAIL ?? "").trim().toLowerCase(),
  /** Optional local mount and scanner-facing symlink library. Empty disables export. */
  mediaSourceRoot: process.env.MEDIA_SOURCE_ROOT ?? "",
  mediaLibraryRoot: process.env.MEDIA_LIBRARY_ROOT ?? "",
  nodeEnv,
};
