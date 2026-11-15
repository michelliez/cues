# Cues bug-fix implementation log

**Update (2026-11-15, merge with main):** fix 4 (camera-only decisions) was dropped. `main`
(Keith, 308beae) removed camera-only flags from the dashboard: a person appears for the teacher
only through an agent review. `web.flag_decisions`, `TeacherFlagDecision`, `web/lib/flag-decisions.ts`
and migration `20261115000200` are removed. The review-reset repair (fix 3) is kept and is applied
to the hosted project as `20261115082639_review_resolution_marks` (its old number, `000100`, is
Keith's `task_observable`).

This is the working reference for the sequential fixes requested on 2026-11-15.
Read it with `backend-audit-2026-11-15.md` before starting another fix. The PRD is
still the product source of truth. Update this log with actual verification
results before moving to another issue; a local test pass is not a hosted rollout.

**Latest user constraint (2026-11-15): keep these changes local to the `evan`
branch. Do not change hosted Supabase yet.** This supersedes the preceding request
to apply the migrations. Do not apply migrations, change hosted data/schema or
enable the new feature. The earlier connection question is no longer needed for
the current scope. Any future hosted rollout needs renewed user authorization.

## Scope and operating rules

- Work on `evan`; preserve the existing uncommitted fixes and unrelated files.
- Implement one audit finding at a time, reproduce it, repair it, verify it, then
  record the result. Stop at the end of this finding for the user's next request.
- Use the existing Supabase RPC architecture, shared Python contracts and local
  vision/worker mark readers. Do not add another backend server or provider.
- No camera frames, images, diagnoses or expression labels enter decision records.
- A teacher's support decision is not intervention approval and changes no task.
- Do not deploy, apply hosted migrations, send notifications, restart another
  worktree or contact Vercel during these implementation steps.
- Schema/contract changes need documented rollout instructions and team sign-off
  in the eventual PR. Do not claim those sign-offs or live checks happened.

## Findings and current status

| Audit finding | Status | Evidence / remaining requirement |
|---|---|---|
| 6. Missing local sender dependency | Verified locally | Lockfile install, sender import, TypeScript and notification tests passed; no dependency versions changed |
| 3. Resolved review returns as a camera flag | Implemented; verified locally | Migration `20261115000100`, queue suppression, consistent review/mark lock order; 79 database + 225 web + 35 consumer tests, lint/types/build passed |
| 4. Camera-only decisions lose the answer | Implemented; verified locally | Migration `20261115000200`, canonical ledger model, typed RPC acknowledgement and safe flag-off fallback; 98 database + 231 web + 674 Python tests passed; flag remains off |
| 1. Hosted Supabase REST timeout | Reads recovered on runtime recheck | Activities returned 200; one fresh observation matched S3's active task/revision. Original timeout cause remains unknown; no infrastructure change made |
| 5. Running older worktree | Runtime alignment verified | Current dashboard, vision and worker run from this checkout; served dashboard/review props include the current flag-off code. No restart needed |
| 2. No running vision service | Service recovered; camera health verified | Current loopback service reports an open camera, ~30 fps and zero pipeline errors. Gesture accuracy and full teacher-action acceptance remain unverified |

The preceding fix is still uncommitted and its migration is not deployed.
The detailed original evidence remains in `backend-audit-2026-11-15.md`.

## Completed implementation: preserve camera-only teacher decisions (finding 4)

### User story and existing failure

A signed-in teacher sees a person flagged by vision before an agent review exists,
chooses Support needed or No support needed, and can recover that specific answer
from durable state. Today both buttons call `mark_seat_reviewed`, which retains
only a mark and may close an intervening review as `reviewed`.

### Intended contract

- Add an append-only `teacher_flag_decisions` ledger, separate from agent reviews.
  Store a UUID decision id, session/person/activity/revision, observed timestamp,
  confirmed/dismissed choice, server timestamp and verified teacher id.
- Add a narrow authenticated RPC. Resolve identity/ownership from Auth and the
  session; verify the active revision/activity and camera flag. Reject stale,
  unflagged, already acknowledged, cross-station and unauthorized submissions.
- The browser supplies an idempotency UUID and the observation it acted on.
  Replaying the same successful request returns its original record without
  advancing the mark; reusing the UUID for another answer/context is rejected.
- Save the decision, resolve any currently pending review for that same task with
  the actual chosen answer, and acknowledge the flag in one transaction. A failure
  anywhere rolls back all three. Do not create a synthetic agent review.
- Keep the prior review-before-mark lock order. Keep raw vision observations and
  their timestamps unchanged. Keep the existing generic Mark as reviewed action.
- Add `web.flag_decisions`, initially off. When off, show the honest single Mark
  as reviewed fallback instead of two buttons that discard the distinction.
- Add the canonical ledger model to `shared/contracts.py` and update PRD section
  17, database/startup docs and this log. No new runtime dependencies.

### Verification gate

1. Database regression: the old mark path demonstrably cannot retain a choice;
   the new RPC must retain distinct confirmed/dismissed records.
2. Test owner authorization, browser table-write denial and ledger immutability.
3. Test revision/activity changes, ended sessions, unknown or unflagged people,
   stale/future observations and already acknowledged flags.
4. Test successful replay, conflicting replay, concurrent duplicate requests,
   a pending review arriving before the decision, and rollback on mark failure.
5. Test the browser request/acknowledgement contract, safe errors, invalid inputs,
   and flag-off fallback. Do not clear the UI before a matching server response.
6. Run the complete database suite with no skips; affected shared/consumer tests;
   web tests, TypeScript, lint and production build. Record exact counts/results.

### Test environment and rollout limits

Temporary PostgreSQL 18.6 tools are in `/tmp/cues-pg-tools`. The tests use a
temporary node-postgres adapter for their unaligned `psql` interface; SQL still
runs in actual PostgreSQL. CI uses native `psql`. Fixtures stop their clusters.
Use `UV_CACHE_DIR=/tmp/cues-audit-uv-cache` for uv. No hosted credentials are used
by these database tests.

Apply the prior repair migration and this task's new migration in order before
enabling the flag. The hosted project, signed-in browser, Realtime and real
camera flow remain separate live acceptance checks. A slow agent review inserted
after the decision transaction is not automatically evidence of a new teacher
choice; this task must not fabricate a review or invent agent evidence for it.

### Work and verification record

- Started: scope checked against the audit, current code, PRD and team rules.
- Skills used: backend architecture (`vercel:create-a-backend`) and full-story
  verification (`vercel:verification`). Keep the current RPC/database architecture.
- Backend implemented in migration `20261115000200_teacher_flag_decisions.sql`.
  The immutable ledger has unique request IDs and unique session/person/revision/
  observation tuples. A transaction advisory lock serializes decision requests
  without blocking vision's observation row; session locks protect activity/revision.
- Identity and permission: only an authenticated session owner may record a choice.
  The server derives the actor and timestamp. Readers are session-owner scoped;
  anonymous/backend roles cannot call the RPC; direct table writes and updates/
  deletes are denied. Service-role reads remain available for explicit backend use.
- Validation: current activity/revision and an actual flagged person are required.
  Observations must be within 30 seconds, with a 5-second future camera-clock
  tolerance; a mark at/after the submitted observation rejects an old flag. Camera
  heartbeats may advance, so exact latest-row timestamp equality is not required.
- Atomicity: the ledger insert, matching pending review decisions and mark are one
  transaction. Other activities' pending requests remain untouched. An identical
  replay returns its original record even after session end, without a new mark.
  Conflicting request reuse or a second request for the same observation fails.
- Frontend implemented in `web/lib/flag-decisions.ts` and `FlagDecisionButtons`.
  Validate the returned request/session/person/activity/revision/observation/choice
  and actor/timestamp before clearing anything. Keep the request UUID and original
  observation across retries; disable double submissions and show safe inline errors.
  A failed/missing RPC never falls back to the lossy acknowledgement-only call.
- `web.flag_decisions` is wired to both Classroom and To review, default **false**.
  Off: the existing generic Mark as reviewed action is used. On: save the durable
  choice, and remove only requests for that same session/person/activity locally.
- Red evidence: both camera-only persistence tests failed before the new RPC existed.
  They passed after implementation. Additional SQL tests cover rollback, authorization,
  immutability, stale context, retries after session end, concurrent same/different IDs,
  a pending review already present at the decision, and leaving another activity alone.
- Shared contract: `shared.contracts.TeacherFlagDecision` is frozen and forbids extra
  fields; actual SQL responses validate against it. All 12 event types remain unchanged.
- Documentation updated: PRD §13/§17, `supabase.md`, `STARTUP.md`, the notes index and
  this log. Scope stayed within finding 4; no dependency/version change or new backend.
- Verification complete locally: **98 database tests with no skips** (47.70s),
  including full migration replay; **231 web tests**; **674 Python tests** (4 existing
  skips: three hardware checks and one credential-dependent integration check);
  **83 focused shared/flag/mark-consumer tests**; TypeScript; ESLint; Ruff lint and
  formatting across all 127 Python files; production build; mechanical UI detector
  (no findings). Initial full-web failure was an old source assertion expecting the
  lossy mark RPC; it now asserts the durable decision path and rollout fallback.
  TypeScript caught an existing `forEach` passing its index into the newly scoped
  mark callback; an explicit one-argument adapter corrected that wiring before the
  final checks. No unresolved local verification failures remain.

#### Reproduce the final checks

From the repository root (the PostgreSQL tools here are temporary test tooling):

```bash
PATH="/tmp/cues-pg-tools:/tmp/cues-pg-tools/node_modules/@embedded-postgres/darwin-arm64/native/bin:$PATH" UV_CACHE_DIR=/tmp/cues-audit-uv-cache LC_ALL=en_US.UTF-8 uv run pytest supabase -q
UV_CACHE_DIR=/tmp/cues-audit-uv-cache uv run pytest vision shared/tests agent/tests -q
UV_CACHE_DIR=/tmp/cues-audit-uv-cache uv run ruff check vision shared agent supabase
UV_CACHE_DIR=/tmp/cues-audit-uv-cache uv run ruff format --check vision shared agent supabase
```

From `web/`:

```bash
npm test
./node_modules/.bin/tsc --noEmit
npm run lint
npm run build
```

Socket/process tests and the local PostgreSQL clusters need permission to create
local sockets and inspect their own test processes. Builds need compiler/font
access. The successful runs used those permissions; a sandbox denial is not
reported as a product failure. Fixtures stopped their temporary clusters.

### Rollout and next-step handoff

- Both local repair migrations remain unapplied to the hosted project. Feature off.
- No Vercel calls, live notification sends, camera activation or other-worktree restart.
- Hosted database access, Auth/Realtime, signed-in browser/camera acceptance and all
  three owners' shared-contract sign-offs remain unverified/unrecorded.
- Remaining audit findings are hosted data availability and local runtime/checkout
  alignment. Recheck actual listeners, working directories and project health before
  choosing that next task; do not change runtime state based only on the original snapshot.

## Runtime alignment recheck (finding 5) — 2026-11-15

### Authorized scope

The user asked to continue with the proposed local-runtime alignment step. Recheck
the processes and replace a stale dashboard only if it is still serving the wrong
checkout. Verify the dashboard before doing further vision or database rollout
work. The original audit is a historical snapshot, not a command to restart a
now-healthy process.

### Observed current state

The runtime had already changed before this step. No restart or source fix was
needed. All paths below were verified from actual process working directories:

| Component | Observed PID | Working directory / result |
|---|---:|---|
| Next.js listener on 3000 | 57788 | `/Users/evan/Documents/cues/web` |
| Vision listener on 8000 | 57770 | `/Users/evan/Documents/cues` |
| Python agent worker | 57771 | `/Users/evan/Documents/cues` |
| Python stack launcher | 57752 | `/Users/evan/Documents/cues` |

The uv runner parents (57768 for the worker and 57744 for the launcher) are wrapper
processes, not evidence of duplicate Python workers. The checkout is `evan` at
`869ab99` plus the preserved, uncommitted repair changes. PIDs are a snapshot and
must be rediscovered before any future process action.

### Verification evidence

- `GET /dashboard`, `/review` and `/login`: **200**.
- Dashboard and review responses include `flagDecisionsEnabled: false`, proving
  that the running server serves the current repair's page props with the rollout
  feature disabled, rather than the older worktree's page implementation.
- `GET /api/notifications/register` and `/api/notifications/test`: **405**, as
  expected for POST-only endpoints. Both modules compiled and loaded; no POST,
  registration, notification or consent change was performed.
- `GET 127.0.0.1:8000/health`: **200**, camera open, 29.8 fps, frame age 0.03 seconds,
  zero pipeline errors; session lifecycle, station configuration, review marks and
  Supabase event flags enabled. No image/stream was fetched.
- `GET 127.0.0.1:8000/config`: **200**, station S3, unpinned, not busy.
- Supabase activities read: **200**, including a backend-authenticated zero-row
  schema probe. The previously observed REST timeout is not currently reproduced.
- S3 has exactly one active session. A bounded observation read returned one row,
  fresh within 10 seconds, matching the active activity and revision. Only counts
  and consistency were reported; no person records or camera data were copied.
- `teacher_flag_decisions` read: **404 / PGRST205** (missing from the REST schema).
  Do not enable the new feature on this evidence. Official migration-ledger and
  hosted rollout verification are still required; a healthy read endpoint does
  not establish that the staged migrations are deployed.
- `git diff --check`: passed. No new application code or dependencies were changed
  during this runtime-only check, so the already-passing suites were not repeated.

### Warnings and limits

The development log contains hydration warnings whose diffs show injected body
attributes `data-new-gr-c-s-check-loaded` and `data-gr-ext-installed`. These are
consistent with browser-extension DOM modification; an application hydration bug
has not been established. Record a clean-browser comparison before changing app
markup. No extension settings were changed and no warning was suppressed.

Browser automation's access host was unavailable, so the signed-in interactive
workflow was not independently exercised. HTTP responses, captured development
logs and backend reads establish the runtime checks above, not complete live
review/approval or gesture-accuracy acceptance.

### Outcome and next gate

Runtime alignment is verified; the already-running camera service is healthy by
its own reported metrics. No processes were killed/restarted, no camera was
activated by this check, and no records, notifications or Vercel state were changed.
The remaining rollout gate is to verify/apply the staged database migrations and
then exercise teacher review decisions against the live stack with authorized
teacher authentication. Keep `web.flag_decisions` off until that gate passes.

## Hosted rollout request withdrawn — 2026-11-15

The user initially authorized applying the database changes. Read-only connection
checks found no `DATABASE_URL`/`POSTGRES_URL` or Supabase access token in the normal
project configuration, no linked project metadata, and no connected Supabase
integration. The official CLI's project-list command reported no access token;
the migration-list helper stopped because no saved database URL was configured.
Neither command applied SQL or changed hosted data. No migration history was
repaired and no feature flag was enabled.

The user's subsequent instruction explicitly withdrew hosted changes and kept
the work local to this branch. Both repair migrations and the implementation
remain local and uncommitted with the previous verification results intact.
No new runtime/dependency change was required. The current task does not require
database credentials or a Supabase integration connection.

## Agent information audit — 2026-11-15

The user asked whether the agents work and whether hardcoded behavior prevents
them from relaying useful information. See
[agent-information-audit-2026-11-15.md](agent-information-audit-2026-11-15.md) for
the complete trace, execution evidence, missing context and proposed next scope.

- One actual tool-calling support agent is implemented, with three domain tools;
  progress/escalation/routing are deterministic guardrails, not separate LLM agents.
- A fresh process check found worker PID 66372 in Claude's `hallucination-issue`
  worktree at `5f90b14`, superseding the earlier runtime-alignment snapshot. Its
  checked agent-core files match this branch, but this branch's local changes
  should not be assumed active there. Nothing was restarted or merged.
- 121 targeted agent tests passed. A real Groq smoke check with three synthetic
  scenarios and in-memory-only reviews was rate-limited in every case; no live
  inference success is claimed. It did not contact Supabase or send notifications.
- Main relay gaps: hidden/rewritten rationale; narrow transient history; no live
  prompting-history producer or preference tool; monitoring/failure results not
  delivered to the UI; existing open review evidence is never refreshed; optional
  support suggestions are off. Minimal phone notification copy is intentional.
- This step changed documentation only. Proposed next implementation: make the
  existing agent explanation/evidence visible and distinguish camera flags from
  agent assessment/execution state. Richer inputs/status contracts need a scoped
  local design before implementation. The latest local-only restriction still applies.

### Follow-up availability check

A tiny Groq request succeeded (0.61s), but a normal synthetic agent request still
returned `RateLimitError` (0.30s). Both checks disabled provider retries; review
storage was in memory. Photon is independent of Groq, but automatic notifications
are only invoked after a new review is persisted, so a failed model request never
reaches that notification step. No messaging delivery was attempted, no Supabase
changes were made, and no application behavior was modified.
