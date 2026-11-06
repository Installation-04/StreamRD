import { setupRouter } from "./routes/setup";
import { libraryRouter } from "./routes/library";
import { errorHandler, requestId } from "./http";
import cors from "cors";
import express, { Express } from "express";
import { attachSession } from "./auth/middleware";
import { config } from "./config";
import { accountRouter } from "./routes/account";
import { adminRouter } from "./routes/admin";
import { authRouter } from "./routes/auth";
import { debridRouter } from "./routes/debrid";
import { downloadsRouter } from "./routes/downloads";
import { healthRouter } from "./routes/health";
import { searchRouter } from "./routes/search";

/** Builds the Express app; exported separately so tests can run it in-process. */
export function createApp(): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(requestId);
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
  app.use("/api/account/setup", setupRouter);
  app.use("/api/account", accountRouter);
  app.use("/api/debrid", debridRouter);
  app.use("/api/search", searchRouter);
  app.use("/api/downloads", downloadsRouter);
  app.use("/api/admin/library", libraryRouter);
  app.use("/api/admin", adminRouter);

  app.use((_req, res) => res.status(404).json({ error: "Not found" }));
  app.use(errorHandler);
  return app;
}
