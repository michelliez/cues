# Backend and local runtime audit — 2026-11-15

Scope: local dashboard, camera/tracking, session state and teacher reviews. This is a diagnosis, with no application fixes, database writes, notifications, deployments, camera activation or changes to the existing dashboard process. Vercel was not queried.

The current `evan` checkout is at `869ab99`. The dashboard listening on port 3000 runs from `.claude/worktrees/workflow-feature-check-c2c5ff/web` at `e6951ac`.

## Findings in priority order

### 1. Blocker: Supabase data requests timed out from this machine

Using the configured backend credentials without logging their values:

- `GET /auth/v1/health`: HTTP 200 in 0.46 seconds.
- `GET /rest/v1/`: read timeout after the configured 12-second timeout.
- Independent `GET /rest/v1/activities?select=id&limit=10`: read timeout after 25.12 seconds.
- The browser and backend configuration point at the same Supabase project.

Impact: authentication can appear healthy while the data operations needed for station resolution, session controls, people, review requests and review actions are unavailable. This observation is specific to these requests from this machine; it does not establish a global Supabase outage, rate limiting, or database corruption. The browser uses its own publishable-key/authenticated requests, which were not replayed with a teacher session.

Next: inspect the project's REST/database health and infrastructure logs before retrying a full camera-to-review run. Do not repair migrations or delete records based on this evidence.

### 2. Blocker: no local vision service was running

No TCP listener was present on port 8000, and an unsandboxed request to `http://127.0.0.1:8000/health` failed to connect. The dashboard on port 3000 returned HTTP 200.

Impact: the local camera stream, health endpoint and station handoff are unavailable. The current agent source also requires the local vision assignment to identify the station it consumes (`agent/seat_state_runtime.py`, `SupabaseSeatStateSource.fetch`). A standalone dashboard does not prove the observation-to-review pipeline is running.

This is a runtime condition, not evidence of a camera-model defect. No real camera was activated during the audit.

Next: after backend data access recovers, run the complete stack from the intended checkout and check vision health, station assignment and the worker together.

### 3. High: resolving an agent review does not acknowledge the camera flag

`web/components/dashboard.tsx:610` removes the resolved review but does not call `applyMarked` or otherwise suppress/reset its camera flag. The latest `resolve_teacher_review` definition in `supabase/migrations/20261114000600_teacher_ownership.sql:44` updates only `teacher_reviews.status` and `resolved_at`. Later migrations do not replace this function with a mark-producing version. Vision and the agent read acknowledgements from `seat_review_marks`.

With `web.review_waiting` enabled by default, the queue includes fresh flagged people without a pending request. A deterministic replay of the actual `reviewQueue` helper showed:

| State | Pending review | Extra camera flag | Queue count |
|---|---:|---:|---:|
| Before resolving | 1 | 0 | 1 |
| After resolving, camera still reports review | 0 | 1 | 1 |
| After Mark as reviewed | 0 | 0 | 0 |

Impact: a teacher can answer a review and immediately see the same person as an unresolved camera flag. The ordinary review answer also does not restart the vision/agent timers the way Mark as reviewed does. This was reproduced at the queue-helper boundary and traced through source; a live authenticated database transition was not exercised.

Next: define acknowledgement semantics for both answers, implement the required review transition and acknowledgement atomically, and verify that the queue stays clear until a fresh stall. Preserve the teacher's confirmed/dismissed decision.

### 4. High: camera-only decision buttons discard the selected answer

In `web/components/mark-reviewed-button.tsx:112`, `FlagDecisionButtons.decide(choice)` uses the choice for the Saving label, but both choices call only `markSeatReviewed(client, sessionId, seatId)`. That helper calls `mark_seat_reviewed`, which accepts no decision parameter. `seat_review_marks` records a timestamp and teacher, with no support-needed/no-support-needed outcome.

Impact: for a person flagged before an agent review exists, Support needed and No support needed have identical persistent effects. The UI presents a decision that cannot be recovered from stored state. If a review arrives before the mark executes, the mark can close it as reviewed without preserving the answer the teacher selected.

Next: either persist a typed teacher decision for this path, including concurrency semantics, or present it as a single acknowledgement action. Shared schema changes require the repository's contract/sign-off process.

### 5. Medium: localhost is serving a different, older worktree

The port-3000 listener's working directory is `.claude/worktrees/workflow-feature-check-c2c5ff/web`, at `e6951ac`. The pulled checkout is at `869ab99`, which includes the newer Attention-panel decision buttons from `d7ca00a` / PR #103.

Impact: pulling main into this checkout cannot update the separate running worktree. Local observations and tests against this checkout can describe different behavior. This is a confirmed checkout mismatch, not a conclusion that every observed bug comes from stale code.

Next: choose one checkout and restart all components from it. Do not stop another worktree's server without coordinating its use.

### 6. Medium: this checkout's installed web dependencies are incomplete

`web/package.json` and its lockfile declare `cues` as a local dependency on `../cues`, but `web/node_modules/cues` is absent. TypeScript reported:

```text
lib/notification-send.ts(2,79): error TS2307: Cannot find module 'cues/send' or its corresponding type declarations.
lib/notification-send.ts(24,66): error TS18046: 'error' is of type 'unknown'.
```

The second error follows the unresolved `SpectrumSendError` import. The running worktree has the expected `web/node_modules/cues -> ../../cues` link.

Impact: this checkout does not pass TypeScript validation; its notification test route imports the unresolved module. This establishes installation drift, not a repository dependency declaration defect or a failure in the running worktree's sender.

Next: install from `web/package-lock.json` with `npm ci`, then repeat type checking. No dependency versions need to change based on these findings.

## Verification and limits

- Python environment synchronized with `uv sync`, using a temporary uv cache because the standard cache is outside the writable sandbox.
- Initial Python suite: 666 passed, 6 failed, 4 skipped. All six failures were sandbox restrictions on temporary socket binding or `ps` execution.
- Reran both affected launcher test files outside the sandbox: all 12 passed. Combined coverage yields 672 passing Python tests and 4 skips, with no remaining reproduced Python unit-test failure. The skips cover three hardware tests and one credential-dependent integration test.
- Web tests: 222 passed, none failed.
- Web ESLint: passed.
- Ruff lint and formatting: passed across vision, shared, agent and Supabase.
- TypeScript: failed as described in finding 6.
- Supabase tests: all 71 skipped because local PostgreSQL tools are unavailable. SQL migration replay and permissions were not verified in this audit.
- A local production build remained at “Creating an optimized production build” without completing. It was stopped, along with its child process. No successful production build is claimed; the cause of the stall was not established.
- Browser automation was unavailable, so the signed-in UI and console were not inspected. HTTP 200 alone does not verify an authenticated dashboard flow.
- The timed-out REST requests prevented inspecting hosted rows or deployed schema. No conclusion about data corruption, duplicate reviews, stale rows, or applied migrations is supported.
- Camera accuracy, person-ID stability and two-laptop behavior remain unverified. The existing real-hardware gaps in `notes/outstanding-work.md` still apply.

Recovery order: restore/diagnose REST data access; align the running checkout and dependencies; start and inspect the whole local stack; fix and verify the two teacher-decision paths; then exercise real-camera acceptance checks. A green unit suite cannot replace those boundary checks.

## Sequential remediation — 2026-11-15

1. **Finding 6 resolved and verified.** Ran `npm ci` in `web/`, including its existing notification-package postinstall. No package versions or lockfiles changed. `next typegen` and `tsc --noEmit` passed; all 14 notification/settings/registration tests passed; an import-only check using the installed `tsx` runner successfully loaded `sendSpectrumMessage` and `SpectrumSendError` from `cues/send`. No notification was sent. Plain Node strip-only mode cannot execute the sender's TypeScript parameter property, so the import check used the project's TypeScript runner.
2. **Finding 1 remains blocked.** Rechecked independently: Auth health returned 200 in 0.50 seconds; a backend-key activity read timed out after 15 seconds; a browser publishable-key activity read timed out after 10.08 seconds; a request without credentials returned 401 in 0.17 seconds. The credential gateway responds, but authenticated REST data access is still not verified. Supabase management access is needed to inspect service/database logs. The available Supabase plugin was discovered but is not installed or connected. Other fixes have not started, preserving the requested verification gate between issues.
3. **Finding 3 implemented and verified locally.** On the user's next request, Supabase REST still timed out. The independent review-reset repair is in `supabase/migrations/20261115000100_review_resolution_marks.sql` and the dashboard. A confirmed/dismissed transition now acknowledges the active matching task atomically, preserving the decision and raw camera observations. The dashboard suppresses the answered flag until vision consumes the mark, without hiding another task/session or a newer observation. The migration aligns Mark as reviewed's lock order with the answer path; a concurrency regression test reproduced the deadlock before that correction and passed afterwards.

   Verification: the new acknowledgement/rollback tests failed against the old behavior, then passed after the repair. Final checks passed: **79 database tests with no skips**, including fresh migration replay and concurrent requests; **225 web tests**; **35 vision/agent mark-consumer tests**; TypeScript; ESLint; Ruff lint/formatting; and a local production build. Database SQL ran on temporary PostgreSQL 18.6 binaries with a temporary node-postgres adapter implementing the tests' unaligned `psql` command interface; no hosted credentials or project dependency changes were used for those tests. Standard CI continues to use native `psql`. Temporary clusters were stopped by their fixtures. The build produced existing notification-config filesystem-tracing warnings but completed successfully.

   The hosted migration has **not** been applied, and the older worktree's running dashboard was left alone. Deploy the migration before rolling out the dashboard change. Hosted Auth/Realtime, a signed-in browser flow and a real camera are not verified by these local tests. Finding 4 (camera-only buttons discarding the answer) remains a separate, untouched issue.
4. **Finding 4 implemented and verified locally.** Migration `20261115000200` adds an immutable, owner-scoped `teacher_flag_decisions` ledger and an atomic authenticated decision RPC. The actual choice survives camera acknowledgement and pending-review races; request identity makes retries idempotent, and stale/unauthorized requests fail without clearing the UI. The new `web.flag_decisions` flag defaults off, with a single Mark as reviewed fallback. Final verification passed: 98 database tests (no skips), 231 web tests, 674 Python tests (4 existing hardware/credential skips), types/lint/formatting and a production build. The hosted migrations are unapplied and the flag is off. See [bugfix-implementation-log.md](bugfix-implementation-log.md) for scope, schema decisions, red/green evidence, commands and remaining live checks; use that log before starting the next finding.
5. **Runtime rechecked; findings 1/2/5 changed externally.** The dashboard, vision and worker now run from this checkout; no restart was needed. Dashboard/review/login returned 200 and current rollout flag props were present/off. Vision reported an open camera at 29.8 fps with zero pipeline errors, on unpinned/non-busy S3. Supabase reads recovered: activities returned 200 and S3 had one fresh observation matching its single active session's task/revision. The cause of the earlier timeout is unknown. The decision ledger is still absent from the REST schema (404/PGRST205); staged migration/live decision verification remains pending. Captured browser hydration warnings show injected body attributes and need a clean-browser comparison, not an assumed app fix. Browser automation was unavailable. The detailed process, response and limitation evidence is in the implementation log's runtime recheck section.
6. **Latest scope: local branch only.** After read-only rollout connection checks, the user instructed not to affect Supabase yet. No hosted migration or data change was made. Keep both migrations local on `evan` and the new flag off; the implementation log records this instruction as superseding the earlier rollout request.
