# Coding Standards

Loaded by the implementer and reviewer agents via `.sandcastle/CODING_STANDARDS.md`.

## Stack

- **App (dashboard + API):** Next.js + TypeScript + React, App Router. UI copy in **Catalan**.
- **Worker:** Node.js + TypeScript, `pg-boss` for the polling job queue.
- **Database:** PostgreSQL (Neon, EU region).
- **ORM:** Drizzle, schema lives in `shared/`.
- **Auth:** Auth.js (NextAuth), Google and Microsoft/Azure AD OAuth providers.
- **AI:** Anthropic API — Claude Haiku for triage/classification, Claude Sonnet for draft generation and digests.
- **Layout:** monorepo — `app/`, `worker/`, `shared/` (types + Drizzle schema, imported by both).
- **Deploy:** Render (Web Service for `app/`, Background Worker for `worker/`), auto-deploy on push to `main`.

## Style

- TypeScript everywhere, `strict` mode on.
- Prefer named exports over default exports.
- camelCase for variables/functions, PascalCase for types/components.
- No unused exports, no dead code paths left "for later".
- All persisted multi-tenant tables carry a `tenantId` column — never add a table that implicitly assumes a single tenant.

## Testing

- Red-green-refactor where a test seam already exists or is being introduced for this change.
- Do not invent new test seams (e.g. extracting a function purely so it can be unit-tested) — this produces spaghetti tests. Test through the existing public interface.
- Run `npm run typecheck` before every commit. Run focused tests for the area touched.

## Architecture

- Keep modules focused on a single responsibility.
- API routes stay thin; business logic lives in testable functions, not inline in route handlers.
- The worker never talks to a mail provider's API directly from inside a job body without going through a typed provider client (`shared/`) — keeps Gmail and Microsoft Graph swappable behind one interface.
- OAuth tokens are encrypted at the application layer before being persisted (context.md §7) — never write a raw refresh token to the database.
- Every write that isn't purely internal bookkeeping (classification, draft generated/approved/rejected/regenerated, auto-reply sent) is recorded in the audit log (context.md §7).
- Never commit real secrets — `.env.example` only, real values stay in Render/GitHub Actions secrets.
