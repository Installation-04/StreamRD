# Branches and release channels

| Branch | Purpose | Image | Who should run it |
|---|---|---|---|
| `main` | Released, stable code. Every release tag (`vX.Y.Z`) is cut from here. | `:latest`, `:X.Y.Z`, `:X.Y` | Everyone, for real use |
| `beta` | Release candidates: what `main` is about to become. | `:beta` | People who want to try the next version early |
| `dev` | Day-to-day work. May be rough, but CI must pass. | `:dev` | Developers and testers |

## How a change travels

1. Open pull requests **into `dev`**. CI (server, web, Phosphor, the complete container and the browser journeys) runs on every pull request.
2. When `dev` holds something worth trying, open a pull request **`dev` → `beta`**. Merging publishes the `:beta` image.
3. When a beta has been exercised, open a pull request **`beta` → `main`** that carries the version bump and `docs/releases/vX.Y.Z.md`. Merging it releases automatically (`auto-release.yml`), exactly as before.
4. A fix that cannot wait goes straight to `main` as a pull request, then is merged back into `beta` and `dev`.

## What does not change

- Only tags on `main` publish `:latest` and version tags, and only those are offered by **Admin → System** and `install.sh`. Running `:beta` or `:dev` never causes a stable install to update.
- Every migration is still additive and tested against every earlier release; that applies on all three branches.

## Trying a pre-release

Set `STREAMRD_TAG=beta` (or `dev`) in `~/streamrd/.env` and run `docker compose pull && docker compose up -d`. Go back with `STREAMRD_TAG=latest`.
A pre-release may apply a database migration that an older release cannot read; the verified snapshot taken before it is in `config/streamrd/backups/`. Use a copy of your data, not your only copy.
