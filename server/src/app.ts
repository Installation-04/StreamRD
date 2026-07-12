import cors from "cors";
import express, { Express } from "express";
import { attachSession } from "./auth/middleware";
import { config } from "./config";
import { accountRouter } from "./routes/account";
import { adminRouter } from "./routes/admin";
import { authRouter } from "./routes/auth";
import { catalogRouter } from "./routes/catalog";
import { debridRouter } from "./routes/debrid";
import { healthRouter } from "./routes/health";
import { playRouter } from "./routes/play";

/** Builds the Express app; exported separately so tests can run it in-process. */
export function createApp(): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(
    cors({
      origin: config.corsOrigins === "*" ? true : config.corsOrigins.split(","),
      credentials: true,
    })
  );
  app.use(express.json({ limit: "2mb" }));
  app.use(attachSession);

  app.use("/api/health", healthRouter);
  app.use("/api/auth", authRouter);
  app.use("/api/account", accountRouter);
  app.use("/api/debrid", debridRouter);
  app.use("/api/catalog", catalogRouter);
  app.use("/api/play", playRouter);
  app.use("/api/admin", adminRouter);

  app.use((_req, res) => res.status(404).json({ error: "Not found" }));
  return app;
}
