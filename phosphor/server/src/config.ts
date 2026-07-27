/** Static process configuration read from environment variables. */
export const config = {
  port: parseInt(process.env.PORT ?? "61337", 10),
  jwtSecret: process.env.JWT_SECRET ?? "phosphor-dev-secret-change-me",
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? "7d",
  apiBaseUrl: process.env.API_BASE_URL ?? "http://localhost:61337",
  lanUrl: process.env.LAN_URL ?? "",
  publicUrl: process.env.PUBLIC_URL ?? "",
  /** Comma-separated list of allowed CORS origins; "*" allows any. */
  corsOrigins: process.env.CORS_ORIGINS ?? "*",
  /** Users with this email are promoted to admin on signup/startup. */
  adminEmail: process.env.ADMIN_EMAIL ?? "",
  nodeEnv: process.env.NODE_ENV ?? "development",
};
