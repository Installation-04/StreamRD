# Search and queue validation

Backend regression coverage includes FIFO execution, saturation/queue timeout,
slot release after failure, stalled HTTP bodies, shared indexer work, config-key
separation, cache invalidation via admin edits/imports/settings, partial search
results, refresh coalescing, transient recovery, credential changes, account
isolation, deleted jobs and finished-but-unresolved transfers.

A headless Chromium test used intercepted API fixtures and the browser's controlled
clock with sixteen active jobs. It verified:

- No more than three simultaneous refresh requests, even after advancing a slow
  in-flight cycle by sixty seconds; no overlapping automatic list fetches.
- Twelve-job batches rotated to later jobs; the next unchanged round waited eight
  seconds after the initial four-second delay.
- Retryable HTTP 503 responses kept job pills active and produced no page errors.
- Synthetic visibility-change events stopped automatic polling during a two-minute
  clock advance and triggered an immediate cycle on visibility restoration.
- Removing a job updated the queue without reviving it through a stale refresh.

These are deterministic fixture checks, not production-load measurements, real
subscription/indexer validation, or operating-system background-throttling tests.
No external services or credentials are needed by these tests. Run backend checks
from phosphor/server with `npm test` and `npm run build`; build the UI from
phosphor/web with `npm run build`.
