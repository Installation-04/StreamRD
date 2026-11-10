# Releasing StreamRD and Phosphor

The four server/web packages share a SemVer version and one annotated repository
tag: `vMAJOR.MINOR.PATCH`. This release line covers both products.

## Automatic releases

Releases are created by the **Auto release** workflow (`.github/workflows/auto-release.yml`, logic in
`infra/auto-release.sh`), so nobody has to push a tag:

1. A pull request bumps `version` in the four packages (step 1 below) and adds `docs/releases/vX.Y.Z.md` (step 2).
2. You merge it. When **every check** on the merge commit has passed (both CI workflows, the container
   build and the browser journeys), the workflow creates the annotated tag `vX.Y.Z` on that commit and
   starts the **Release** workflow (packages the documentation, publishes the GitHub Release with the notes)
   and the **Publish image** workflow (builds and pushes `ghcr.io/<owner>/streamrd:X.Y.Z` and `:latest`).
3. Nothing happens for a merge that does not change the version, or whose version is already tagged. If a
   check is still running or has failed, nothing is released; the last workflow to finish tries again, and a failed
   check means no release until it is fixed and the commit passes.

To release by hand (for example after fixing a red check), open **Actions → Auto release → Run workflow**
on `main`; tick *dry run* to see what it would do. A manual run fails visibly instead of waiting.
To switch the automatic path off, set the repository variable `AUTO_RELEASE` to `false`
(Settings → Secrets and variables → Actions → Variables). If the tag was created but a later step failed, run
**Release** and **Publish image** from the Actions tab and choose the tag as the branch/tag to run on.

Requirements: the workflow needs the repository's *Workflow permissions* to allow it to write
(it declares `contents: write`, `actions: write`, `checks: read`), and a tag ruleset on `v*` must not block the
GitHub Actions bot. A tag pushed by a workflow does not trigger other workflows, which is why this one starts
Release and Publish image itself. Pushing a tag by hand (steps 5 and 6 below) still works and starts them as before.

## Updates must never cost anyone data

Everyone updates the same way (Admin → System, `docker compose pull && docker compose up -d`, or the installer), so every release
has to be safe to apply on top of any earlier supported version. These rules are enforced by tests that run on every pull request:

- **Migrations only add.** A migration may create tables, columns and indexes. Dropping, renaming, deleting or truncating anything
  fails the *keeps every migration additive* test unless the file carries a reviewed `-- destructive-ok: <reason>` line, and then the release notes must say so.
- **Every earlier checkpoint upgrades.** The *upgrades from every earlier checkpoint* test builds a database at each point in the committed
  migration chain, fills it with data, runs the real upgrade and requires a verified backup first and every existing row unchanged afterwards.
  A new migration is covered automatically.
- **New settings and columns default to the old behaviour**, so an update changes nothing until an administrator opts in.
- **Never delete user data in code that runs at start-up.** Removing something (an item type, an old screen) is a separate, announced step with a backup, never part of an automatic upgrade.
- **Release notes have an *Upgrading* section** that says what the upgrade does to the database and whether anything needs doing by hand (normally nothing).

If a change cannot follow these rules, it does not ship as an ordinary release.

## Release checklist

1. Update `version` in `package.json`, `package-lock.json`, and its root package
   entry in `server/`, `web/`, `phosphor/server/`, and `phosphor/web/`. Preserve
   dependency resolutions unless a dependency change is intentional.
2. Write `docs/releases/vMAJOR.MINOR.PATCH.md` with behavior changes, an *Upgrading* section (what happens to existing data, and that it is safe), verification evidence, and limits. Update wiki sources and real
   screenshots as needed; never include live credentials or private data.
3. Run server tests/type checks and production builds for both products. Build all
   four Docker images and run both `infra/smoke-images.sh` checks. For filesystem
   export changes, run real-file collision/traversal/ownership regressions and
   scanner integration checks. Validate optional Compose configurations.
4. Run `bash infra/package-release.sh /tmp/new-release-assets vMAJOR.MINOR.PATCH`.
   Inspect the screenshot, wiki, and project-tracker ZIPs and verify their checksums. This command only packages files.
5. Commit and push the reviewed changes. Wait for both GitHub CI workflows on that
   commit to pass. Create and push the annotated tag on that same commit:

   ```bash
   git tag -a vMAJOR.MINOR.PATCH -m 'StreamRD and Phosphor vMAJOR.MINOR.PATCH'
   git push origin vMAJOR.MINOR.PATCH
   ```

6. The tag workflow checks package versions, packages the documentation assets,
   and publishes the checked-in notes with screenshots/wiki/project-tracker ZIPs and SHA256SUMS.
   Its manual dispatch also requires a tag ref. Verify the published release's
   target commit, notes, and downloadable assets. If workflow execution is not
   available, use `gh release create TAG --verify-tag --notes-file FILE` with the
   same reviewed assets; do not create a release pointing at another commit.
7. Synchronize `docs/wiki/*.md` to the repository's separate `.wiki.git` checkout,
   preserving pages owned by others. Inspect and commit the wiki update, then push
   its normal branch. Do not put application secrets or databases into the wiki.

Pushing the tag also runs `publish-image.yml`, which publishes the all-in-one image to
the repository's container registry (after checking the tag matches the package
versions). Verify the package page and, if you want anonymous pulls, make it public.

Release publication does not deploy a running installation or publish a cloud
environment configuration. GitHub supplies source archives automatically; the
release workflow publishes documentation assets, and `publish-image.yml` publishes the
all-in-one image; native installers are not published.
