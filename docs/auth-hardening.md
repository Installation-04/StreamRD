# Authentication hardening (both products)

## Upgrade and configuration

Apply the updated Prisma schema and regenerate the client before starting either
backend. Both add User.sessionVersion (default zero) and RevokedSession. Prisma's
SQLite update rebuilds User, so back up deployed databases first. From `server/`,
validate the disposable upgrade fixtures with:

```sh
npx tsx scripts/validate-auth-upgrade.ts
npx tsx scripts/validate-auth-upgrade.ts ../phosphor/server
```

They preserved existing data in all 11 prior StreamRD tables and 7 Phosphor tables,
including password hashes, provider keys, profiles/favorites/catalog/progress or
indexers/jobs/saved searches, with no foreign-key violations. This does not replace
a restore test for a particular deployed database.

JWTs now require the product issuer (streamrd/phosphor), HS256, valid claim types,
a token ID, expiry and session version. Previously issued tokens need one new
sign-in. Native clients can continue treating tokens as opaque strings.

Outside development/test, JWT_SECRET must be at least 32 bytes, nonblank and not a
bundled placeholder. Generate a random secret (`openssl rand -hex 32`) and keep it
stable in deployment settings. Missing development secrets generate an ephemeral
in-memory value that is never printed. Without a stable configured secret,
development sessions and file choices end on restart, and persisted source-job
keys are not reused. Plan deliberate key rotation with those dependencies in mind.

## Session behavior

POST /api/auth/logout durably revokes the current token ID; other sessions remain
valid. Anonymous/repeated signout is safe. Clients that only clear local storage
must call the endpoint to revoke server use. Browser signout still clears locally
if the backend is unreachable; durable revocation requires a successful response.

Password changes and admin deactivation increment sessionVersion, invalidating all
older tokens, including after account reactivation. Password change verifies the
current password and uses an atomic compare/update to avoid overwriting concurrent
credential changes. Its response now adds token and role to `{ ok: true }` for the
initiating browser to save. Older clients ignoring this replacement need to sign
in again. The Phosphor web form now calls the backend's POST method.

Protected requests re-read current account state/role with revocation/version
filtering and minimal fields. Web cookies use Secure on HTTPS and SameSite=Lax;
the role cookie remains a UI hint. Transient profile-request failures retain valid
login cookies; HTTP 401 clears an invalid session.

## Bootstrap and errors

Signup hashes outside a transaction, takes a SQLite write lock before counting
users, and creates the account in that transaction. Concurrent first signups yield
one bootstrap admin. ADMIN_EMAIL, when configured, reserves that admin role rather
than granting it to an unrelated first signup. This is not email verification:
initial setup still needs controlled access.

Existing async route callbacks use asyncHandler, and requireAuth forwards DB
errors. Unexpected failures return generic JSON and a server-generated request ID.
Central logs contain only method, registered route pattern and ID; raw exception
messages, queries, bodies and headers are excluded. Malformed cookies become
unauthenticated requests; malformed JSON returns 400, oversized JSON 413, and
uniqueness conflicts 409. Explicit business/provider error responses are unchanged.

## Evidence and remaining work

Backend regressions cover revocation, password rotation, deactivation/reactivation,
algorithm/issuer/claim validation, signing defaults, concurrent signup, reserved
admin email, duplicate conflicts, malformed inputs, and rejected route/middleware
promises. Real local browser/API checks for both products verified password forms,
replacement cookies, old-token rejection, logout revocation, and retaining valid
cookies after temporary profile errors, with no page errors.

Provider keys remain plaintext in the existing database. Browser tokens remain
JavaScript-accessible; HttpOnly/BFF sessions and CSRF handling need a compatible
client/API migration. Business/provider logs need a separate redaction review.
Expired revocations need retention cleanup. Production entrypoints, frozen installs,
and backup/restore checks are covered in [production-runtime.md](production-runtime.md).
Versioned schema migrations and exact historical upgrade fixtures are now covered in
[database-upgrades.md](database-upgrades.md).
