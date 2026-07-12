/** Static process configuration read from environment variables. */
export const config = {
  port: parseInt(process.env.PORT ?? "4000", 10),
  jwtSecret: process.env.JWT_SECRET ?? "streamrd-dev-secret-change-me",
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? "7d",
  /** Base URL the API is reachable at (LAN, reverse proxy or VPN address). */
  apiBaseUrl: process.env.API_BASE_URL ?? "http://localhost:4000",
  lanUrl: process.env.LAN_URL ?? "",
  publicUrl: process.env.PUBLIC_URL ?? "",
  /** Comma-separated list of allowed CORS origins; "*" allows any. */
  corsOrigins: process.env.CORS_ORIGINS ?? "*",
  /** Users with this email are promoted to admin on signup/startup. */
  adminEmail: process.env.ADMIN_EMAIL ?? "",
  nodeEnv: process.env.NODE_ENV ?? "development",
};
