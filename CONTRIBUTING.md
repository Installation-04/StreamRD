# Contributing

StreamRD and Phosphor are independent apps in one repository. Start with the
[project tracker](docs/product/PROJECT-HQ.md), [wiki](https://github.com/Installation-04/StreamRD/wiki),
and [engineering plan](docs/optimization-plan.md). Small fixes, usability reports,
translation/accessibility improvements, and device testing are welcome.

## Development

Use Node 22. For a backend (`server/` or `phosphor/server/`):

```bash
npm ci
npm run db:generate
# Copy .env.example to .env and use a local development database.
npm run db:push
npm run dev
```

For its corresponding web directory, use `npm ci` then `npm run dev`. Defaults
are StreamRD API/web 47821/3000 and Phosphor 61337/3100. The browser API URL is a
build-time setting; use the appropriate NEXT_PUBLIC_API_BASE_URL when needed.
Never develop against a production database or publish private provider keys.

## Reviewable changes

Explain the concrete problem and resulting behavior, include screenshots for
visual changes, and note affected product/client compatibility. Preserve the
legacy API unless an intentional migration is documented. Keep design states
honest and provide accessible labels, focus styles, responsive layouts, and
loading/empty/error states.

Run backend `npm test` and `npm run lint`, and web `npm run build` for the affected
products. Production container and recovery checks are described in
[production-runtime.md](docs/production-runtime.md). For filesystem changes include
real-file traversal, collision, source-preservation, and mount-outage regressions.
Use synthetic fixtures and explicitly separate those results from real providers.

## Reporting

Use the issue templates for bugs and feature proposals. Include the version,
affected product, steps, and sanitized request IDs. Do not attach credentials,
.env files, private indexer URLs, or databases. For a suspected security issue,
use GitHub's private vulnerability reporting when available rather than posting
sensitive exploit details in a public issue.

Maintainers coordinate scope through the project tracker. Reviews should be
specific, respectful, and useful to the person doing the work.

## Database changes

Production changes require immutable versioned SQLite migrations and regenerated
checkpoint metadata. See [database-upgrades.md](docs/database-upgrades.md). Run the
checkpoint generator with `--check` and the migration tests before changing models.
`db push` is restricted to disposable development/test workflows, never a release
upgrade shortcut.
