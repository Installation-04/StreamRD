import { config } from "./config";
import { MediaLibrary } from "./library";

export const mediaLibrary = new MediaLibrary(() => ({ sourceRoot: config.mediaSourceRoot, exportRoot: config.mediaLibraryRoot }));
