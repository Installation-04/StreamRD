const { rmSync } = require("node:fs");
const { resolve } = require("node:path");
// This directory is generated output owned by the build.
rmSync(resolve(__dirname, "..", "dist"), { recursive: true, force: true });
