# Releasing StreamRD and Phosphor

The four server/web packages share a SemVer version and one annotated repository
tag: `vMAJOR.MINOR.PATCH`. This release line covers both products. Native clients
remain independently versioned; only advertise device binaries when built and
tested separately.

1. Update `version` in `package.json`, `package-lock.json`, and its root package
   entry in `server/`, `web/`, `phosphor/server/`, and `phosphor/web/`. Preserve
   dependency resolutions unless a dependency change is intentional.
2. Write `docs/releases/vMAJOR.MINOR.PATCH.md` with behavior changes, upgrade
   requirements, verification evidence, and limits. Update wiki sources and real
   screenshots as needed; never include live credentials or private data.
3. Run server tests/type checks and production builds for both products. Build all
   four Docker images and run both `infra/smoke-images.sh` checks. For filesystem
   export changes, run real-file collision/traversal/ownership regressions and
   scanner integration checks. Validate optional Compose configurations.
4. Run `bash infra/package-release.sh /tmp/new-release-assets vMAJOR.MINOR.PATCH`.
   Inspect both ZIPs and verify their checksums. This command only packages files.
5. Commit and push the reviewed changes. Wait for both GitHub CI workflows on that
   commit to pass. Create and push the annotated tag on that same commit:

   ```bash
   git tag -a vMAJOR.MINOR.PATCH -m 'StreamRD and Phosphor vMAJOR.MINOR.PATCH'
   git push origin vMAJOR.MINOR.PATCH
   ```

6. The tag workflow checks package versions, packages the documentation assets,
   and publishes the checked-in notes with screenshots/wiki ZIPs and SHA256SUMS.
   Its manual dispatch also requires a tag ref. Verify the published release's
   target commit, notes, and downloadable assets. If workflow execution is not
   available, use `gh release create TAG --verify-tag --notes-file FILE` with the
   same reviewed assets; do not create a release pointing at another commit.
7. Synchronize `docs/wiki/*.md` to the repository's separate `.wiki.git` checkout,
   preserving pages owned by others. Inspect and commit the wiki update, then push
   its normal branch. Do not put application secrets or databases into the wiki.

Release publication does not deploy a running installation or publish a cloud
environment configuration. GitHub supplies source archives automatically; the
workflow publishes documentation assets, not container images or native installers.
