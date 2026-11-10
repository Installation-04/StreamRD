import { discoveryRouter, requestsRouter, adminRequestsRouter } from "./routes/requests";
import { requestSettingsRouter } from "./requests/config";
import { sharedLibrariesRouter, adminSharedLibrariesRouter } from "./routes/shared-libraries";
import { accountLibraryRouter } from "./routes/account-library";
import { accountMetadataRouter } from "./routes/accountMetadata";
import { metadataRouter } from "./routes/metadata";
import { systemRouter } from "./routes/system";
import { setupRouter } from "./routes/setup";
import { libraryRouter } from "./routes/library";
import { errorHandler, requestId, securityHeaders } from "./http";
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
  app.use(securityHeaders);
  app.use(
    cors({
      origin: config.corsOrigins === "*" ? true : config.corsOrigins.split(",").map(origin => origin.trim()).filter(Boolean),
      credentials: true,
      // Lets the browser read the file name when it downloads an export across origins.
      exposedHeaders: ["Content-Disposition"],
    })
  );
  app.use(express.json({ limit: "2mb" }));
  app.use(attachSession);

  app.use("/api/health", healthRouter);
  app.use("/api/discovery", discoveryRouter);
  app.use("/api/requests", requestsRouter);
  app.use("/api/admin/requests", adminRequestsRouter);
  app.use("/api/admin/request-settings", requestSettingsRouter);
  app.use("/api/auth", authRouter);
  app.use("/api/account/library/:id/metadata", accountMetadataRouter);
  app.use("/api/account/setup", setupRouter);
  app.use("/api/account/library", accountLibraryRouter);
  app.use("/api/account", accountRouter);
  app.use("/api/debrid", debridRouter);
  app.use("/api/search", searchRouter);
  app.use("/api/downloads", downloadsRouter);
  app.use("/api/shared-libraries", sharedLibrariesRouter);
  app.use("/api/admin/shared-libraries", adminSharedLibrariesRouter);
  app.use("/api/admin/metadata", metadataRouter);
  app.use("/api/admin/system", systemRouter);
  app.use("/api/admin/library", libraryRouter);
  app.use("/api/admin", adminRouter);

  app.use((_req, res) => res.status(404).json({ error: "Not found" }));
  app.use(errorHandler);
  return app;
}
