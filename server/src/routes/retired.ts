import { Router } from "express";

/**
 * The curated catalogue (hand-added links, its search, favourites, My List and viewing profiles) was retired in v0.18.0.
 * Nothing was deleted: the tables are still in the database, only the doors are closed. A retired door answers 410 so an old
 * client or bookmark gets a clear message instead of a missing page.
 */
export const retiredRouter = Router();
retiredRouter.use((_req, res) => {
  res.status(410).json({ error: "This feature was retired in v0.18.0. Everything now lives in the libraries.", retired: true });
});
