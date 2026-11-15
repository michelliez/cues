# Cues database

## Status

Hosted status was last checked against the Supabase migration ledger with
`scripts/supabase-migrations.py list` on 2026-11-14: migrations through 017 are
applied. Migration 018 and the 20261115000100/20261115000200 repairs are local only. Every
migration is tested by a fresh replay on a local PostgreSQL with minimal Auth stubs
(`supabase/tests/test_migration_replay.py`; this is SQL replay, not full Auth/Realtime
emulation). Per-feature SQL tests are in `supabase/tests/`; they need PostgreSQL's `initdb`,
`pg_ctl` and `psql` on the PATH and are run by the `supabase` CI workflow.

| Migration | Adds |
|---|---|
| `000100_initial_schema` | Core tables (activities, stations, seats, sessions, seat_state, events, alerts, interventions, support_preferences) and read-only demo policies |
| `000200_align_demo_activity` | Aligns the original `raise_hand` activity with the shared contract |
| `000300_teacher_reviews` | Persistent `teacher_reviews` and the one-way pending-to-resolved guard |
| `000310_session_controls` | Session lifecycle (`station_id`, `ended_at`, `revision`), `station_teachers`, and the read/start/end station-session functions |
| `000400_resolve_teacher_review` | The authenticated review-resolution function |
| `000500_add_seat_state_tracking_valid` | `seat_state.tracking_valid` |
| `000510_person_observations` | Simulated person slots `S1-P1` to `S1-P4` |
| `000520_station_session_sync` | `station_runtime`, `report_station_session`, and the stale-write guard for managed stations |
| `000600_teacher_ownership` | `teacher_profiles`, `sessions.teacher_id`, owner-only review reads and resolution |
| `000700_session_owner_on_start` | A started session is owned by the signed-in caller |
| `000800_station_pairing` | Single-use station pairing codes |
| `000900_notification_registration` | Notification consent and registration state |
| `001000_notification_send_result` | Backend-only acknowledgement of a notification send |
| `001100_default_station` | One default station per teacher (`get_or_create_my_default_station`) |
| `001200_live_progress` | `seat_state.evaluated_progress` and the guarded publish function |
| `001300_review_lifecycle` | Reviews close with their session; one open review per person; status `expired` |
| `001400_builtin_gestures` | The built-in gestures in `activities` |
| `001500_review_marks` | Mark as reviewed (`seat_review_marks`, `mark_seat_reviewed`); reviews close when the task is done; status `reviewed` |
| `001600_station_flags` | `read_station_flags` for the dashboard timeline's data |
| `001700_station_writers` | One camera per station (`station_writers`, `claim_station_writer`, `release_station_writer`) |
| `001800_interventions` | **Written, not applied to the hosted project.** The approved intervention menu: `teacher_reviews.suggested_intervention`, `interventions.review_id`, owner-only reads, and `approve_review_intervention` (see below). Needed only by `agent.interventions` and `web.interventions` (both off) |
| `20261115000100_review_resolution_marks` | **Local only, not applied.** Confirmed/dismissed review answers acknowledge the active camera task atomically, without changing the saved decision |
| `20261115000200_teacher_flag_decisions` | **Local only, not applied.** Immutable camera-only teacher decisions and the atomic `record_teacher_flag_decision` RPC; needed by `web.flag_decisions` (off) |

## Camera-only decisions (local migration 20261115000200)

`teacher_flag_decisions` records the teacher's chosen confirmed/dismissed answer
when vision flagged someone before an agent review existed. The canonical model
is `shared.contracts.TeacherFlagDecision`; PRD §17 lists its fields. It stores no
agent rationale, invented review, expression context or images.

`record_teacher_flag_decision(decision_id, session_id, seat_id, activity_id,
expected_revision, observed_at, decision)` returns one JSON record. It verifies
the signed-in session owner and person/station membership, the active activity
and revision, and a currently flagged observation. Both the submitted timestamp
and latest observation must be within 30 seconds, with at most 5 seconds of
future camera-clock tolerance for the submitted timestamp. It rejects an older
already-acknowledged flag. Heartbeats may advance between rendering and submission;
an exact latest-row timestamp match is deliberately not required.

The RPC saves the ledger record, resolves currently pending reviews for that task
with the chosen answer, and writes the existing camera/worker mark in one
transaction. Other activities' requests are untouched. An acknowledgement failure
rolls back the answer and any review transitions. Replaying a successful UUID with
the identical context/choice returns its existing record, even after session end,
without another mark. Changing a replay's context/choice is rejected. Concurrent
decisions serialize with a transaction advisory lock on the session/person; they
do not lock or update vision's observation row. The existing review-before-mark
lock order is retained. A unique observation tuple prevents two request IDs from
answering the same observation twice.

Browser writes are RPC-only; authenticated users read decisions of sessions they
own, while service-role access is read-only. Updates/deletes are prohibited. No
new Realtime subscription or history UI is introduced. Reviews created after the
transaction are not fabricated or automatically assigned this earlier answer.

Rollout: apply migrations in filename order, verify the hosted RPC, then enable
`CUES_FLAG_WEB_FLAG_DECISIONS=1` (or the browser-safe `NEXT_PUBLIC_` form) in the web
environment and rebuild/restart. The flag defaults off; its fallback offers the
existing single Mark as reviewed action. If the RPC is missing or a request fails,
the enabled UI reports the error and does not fall back to discarding the choice.
The request UUID and original observation survive retries in the mounted button.

Verification: SQL tests are in `supabase/tests/test_review_marks.py`; browser
contract/fallback tests are in `web/tests/flag-decisions.test.ts`. Local results and
rollout limitations are recorded in `bugfix-implementation-log.md`. Hosted
deployment, signed-in browser/camera acceptance and team sign-off remain pending.

## Review answers acknowledge the camera (local migration 20261115000100)

Deploy `20261115000100_review_resolution_marks.sql` before the dashboard change.
The existing `resolve_teacher_review` signature, owner checks and returned review
stay unchanged. An after-update trigger writes the resolution timestamp and
authenticated actor into `seat_review_marks` when the review's session is active
and its activity is still current. Both confirmed and dismissed acknowledge the
flag, while retaining their distinct decision values. If the mark fails, the
answer rolls back too. Existing/newer marks are never moved backwards, other
pending reviews are left alone, and no vision observation is fabricated.
`mark_seat_reviewed` acquires review rows before the mark row, matching the answer
path so concurrent Mark as reviewed and review answers cannot deadlock on those
two resources.

The same trigger covers confirmation by the optional intervention-approval path.
Automatic expiry and Mark as reviewed keep their existing behavior. This is a
repair to the existing review workflow under `web.teacher_review_actions`, with
no new feature flag or data fields. Vision and the worker already consume marks.

Tests: `supabase/tests/test_review_marks.py`, `web/tests/teacher-review-actions.test.ts`.
Hosted deployment and team sign-off have not been performed.

## Reconciled migration history

On November 14, 2026 the local chain was made unique without changing SQL:
session_controls moved from 20261114000300 to 20261114000310; person_observations from
20261114000400 to 20261114000510; station_session_sync from 20261114000500 to 20261114000520.
This orders the unconditional `tracking_valid` addition before person observations'
IF NOT EXISTS addition. The Supabase CLI's migration repair marked the earlier ten migrations
applied without replaying SQL; later migrations were applied with `db push`. The earlier
duplicate-history warnings in the historical notes are superseded by this reconciliation.

No project dependency installation is needed for the pinned CLI. The repo-local
config is supabase/config.toml. The helper below loads the saved database URL,
validates it identifies the configured Supabase project and redacts credentials.
It invokes only official CLI commands, never direct migration-ledger SQL:

```bash
uv run python scripts/supabase-migrations.py list
uv run python scripts/supabase-migrations.py dry-run
```

The helper's repair-history action was used once for the verified predecessors;
do not use it to mark future changes applied without executing them.
For a separately authorized real deployment, load DATABASE_URL securely into the
shell and use the same explicit target (CLI 3 uses --remote=<database URL>):

```bash
npx --yes supabase@3.1.0 db push --remote="$DATABASE_URL" --dry-run --skip-vault
# Only after reviewing the pending list and authorizing deployment:
npx --yes supabase@3.1.0 db push --remote="$DATABASE_URL" --skip-vault
```

Never print the connection URL, enable shell tracing, or run a remote db reset.
The earlier duplicate-history warnings in historical notes are superseded by
this reconciliation. Fresh projects should apply the current unique sorted chain.

## One camera per station (migration 017)

`20261114001700_station_writers.sql`. Seat rows are named by station and person number
(`S1-P1`), so two cameras working for the same station overwrite each other and show up as
phantom people. Each camera process claims its station with a random writer id:

- `claim_station_writer(station, writer, ttl)` (backend only) grants the station to the first
  camera and renews its lease on each call; while that lease is fresh (default 10 s) any other
  camera is refused and `station_writers.contested_at` is set. One statement, so concurrent
  claims have exactly one winner.
- `release_station_writer(station, writer)` hands the station over at once when a camera stops;
  a crashed camera's lease simply expires.
- Vision (`vision/station_lease.py`, in `StationSessionSync`) claims before reading the session.
  A refused camera pauses completely (reads nothing, writes nothing), retries about once a
  second, and takes over when the other stops. `GET 127.0.0.1:8000/config` reports
  `station_busy`.
- Teachers of a station can read its `station_writers` row; the dashboard uses it to warn.
- Until the migration is applied vision keeps working with no guard (it warns once).
- The guard is enforced by vision, so a laptop on older code ignores it. Enforcing it in the
  database on `seat_state` writes needs a shared-table change; see `notes/outstanding-work.md`.

Tests: `supabase/tests/test_station_writers.py`.

## Mark as reviewed (migration 015)

`20261114001500_review_marks.sql`:

- **`mark_seat_reviewed(session, seat)`** (signed-in teachers of the station only; the
  browser names just the session and the person). It records a mark in
  `seat_review_marks` and closes that person's open review requests as `reviewed`.
  Vision reads the mark to put the child back to working and restart the no-progress
  timer (flag `vision.review_marks`); the agent reads it to restart stall detection.
  Marking works even when the child has no open review.
- **Completing the task closes the review request.** A trigger on `seat_state` closes
  that person's open reviews for the activity as `expired` when the status becomes `done`.
- `reviewed` is a new review status (a teacher marked the child reviewed); like `expired`
  it is not a decision on the review. A one-time cleanup closes open reviews of children
  who have already completed their task.
- The dashboard button is under the existing `web.teacher_review_actions` flag.

Tests: `supabase/tests/test_review_marks.py`.

## Review lifecycle (migration 013)

`20261114001300_review_lifecycle.sql`:

- **Reviews close with their session.** When a session's `ended_at` is set, its pending
  reviews become `expired` (a trigger, so it covers every way a session can end). A review
  that arrives after its session ended is closed on arrival. `expired` is not `dismissed`:
  the dashboard shows dismissed as the teacher's own "No support needed", and nobody decided
  that. Teachers still resolve reviews only as confirmed or dismissed
  (`resolve_teacher_review` is unchanged); `expired` cannot be reopened or changed.
- **One open review per person.** A partial unique index allows one pending review per
  session, seat and activity. The agent reuses the open one for later evaluations (no new
  row, no second notification) and opens a new one only after it is resolved.
- **One-time cleanup when applied:** pending reviews in sessions that already ended become
  `expired`, and in running sessions the newer duplicates of an open review become `expired`
  (the oldest stays open). Teachers' own confirmed/dismissed decisions are never changed.

Local tests: `supabase/tests/test_review_lifecycle.py` (needs PostgreSQL; see Status above).

## Default station per teacher (migration 011)

`20261114001100_default_station.sql` adds `station_teachers.is_default` (at most one
default per teacher, enforced by a partial unique index) and
`get_or_create_my_default_station()`, callable only by signed-in users and always for
`auth.uid()`. A teacher whose single existing assignment is a station keeps it as their
default (backfilled; Keith → S1). A teacher with none gets a new `S<n>` station with
simulated `S<n>-P1..P4` person slots. Existing stations, sessions and their owners are
not modified.

Local tests (need PostgreSQL's `initdb`, `pg_ctl` and `psql`; skipped otherwise):
`uv run pytest supabase/tests/test_default_station.py supabase/tests/test_migration_replay.py`.

## Station pairing (migration 008)

`20261114000800_station_pairing.sql` adds private, single-use station invitations.
Apply through the reviewed migration sequence; the duplicate history is now
reconciled as described above.

Trusted operator SQL (database owner, or a backend service-role client):

```sql
select * from public.issue_station_pairing_code('S1', 600);
```

Returns a random UUID-format code and expires_at once. Only its normalized
SHA-256 hash is stored. The default lifetime is ten minutes, capped at one hour.
Display/share the code privately; do not put it in application logs. Reissuing
creates another independently valid code; it does not revoke earlier codes.
Service-role operators can invalidate an unused code by deleting its row.

Authenticated frontend contract:

```ts
const { data, error } = await supabase.rpc('redeem_station_pairing_code', {
  code: enteredCode,
});
// data: [{ station_id: 'S1' }]; refresh existing station/session controls afterward.
```

The browser supplies only the code. Case, hyphens and whitespace are normalized.
The server locks the code, checks expiry/unused state, inserts membership for
auth.uid(), and consumes the code atomically. Existing membership is retained
without duplication; the valid code is still consumed. No session is created or
claimed. Existing require_station_teacher and start_station_activity remain intact.

No browser access to code rows or issuance is granted. Redemption is available
only to authenticated callers. Service-role table access/issuance is preserved.
High-entropy generated codes resist guessing; no low-entropy numeric-code flow or
public issuance endpoint is provided. Photon registration and onboarding UI remain
separate work.

Local SQL/race checks (requires already-installed initdb, pg_ctl, psql):

```bash
uv run pytest supabase/tests/test_station_pairing.py -q
```

These tests start/remove a temporary local PostgreSQL cluster and never read
DATABASE_URL or contact hosted Supabase. They validate migration 008 against a
minimal station/Auth prerequisite schema, not a replay of all historical migrations.

`supabase/migrations/20261114000100_initial_schema.sql` implements PRD §17.3 without changing
the shared table/event fields. Apply it once in a new Supabase project's SQL
Editor, apply subsequent migrations in filename order, then run `seed.sql`. The seed uses only simulated data and can be rerun
without resetting existing rows. Do not reapply the migration to an existing schema.

The initial nine tables have Row Level Security enabled. The publishable key can read
simulated seats and their associated station, session, activity and seat state.
These demo rows are publicly readable: use no real student data or private notes
in them. Browser writes are denied. Events, alerts, interventions and support
preferences are server-only. The authenticated resolution RPC exists; teacher login/profile UI and session ownership authorization remain gaps.

`seat_state` is included in the `supabase_realtime` publication. The frontend must
fetch initial state and subscribe to Postgres Changes; the current dashboard implements initial state reads and subscriptions.

Migration `20261114000500_add_seat_state_tracking_valid.sql` adds nullable
`seat_state.tracking_valid` without a default. Apply it after migration 004.
Leaving the column nullable preserves unknown historical observations instead of
marking them valid. Applied to and verified against the hosted project on
November 14, 2026. A live upsert/read through the vision Supabase sink confirmed
both valid tracking and tracking loss, including a null `task_score` during loss.

Set `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` in
`web/.env.local`. Privileged clients use the root `.env` with `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY` (as consumed by the current vision client). Never put
a service-role or secret key in browser variables. Vision cloud event writes also
require the `vision.supabase_events` flag; enable it for the live demo after configuring the backend credentials.

In the SQL Editor, verify tables, RLS, demo rows and publication membership:

```sql
select tablename, rowsecurity from pg_tables where schemaname = 'public' order by tablename;
select * from public.seat_state;
select tablename from pg_publication_tables where pubname = 'supabase_realtime';
begin;
set local role anon;
select * from public.seats;
select * from public.seat_state;
rollback;
```

Once a dashboard subscribes, update a simulated seat through the Table Editor
and verify that its card changes without refreshing. Camera, model, agent,
teacher approval and Photon verification are separate integration work.

Verified against the hosted `cues` project on November 13, 2026:

- All nine tables have RLS enabled.
- The configured publishable key read simulated seat/state fixtures and the
  associated station, activity and session. Seeded status is `idle`, matching
  the existing vision status vocabulary.
- Anonymous INSERT/UPDATE privileges on `seat_state` are absent; reading alerts
  through the publishable key is denied.
- A Postgres Changes subscription using the publishable key received a real
  `seat_state` UPDATE after changing a simulated row's timestamp in the SQL Editor.

The database verification above predates the teacher dashboard implementation.
The dashboard now reads simulated state when `web.dashboard` is enabled; see
`notes/web.md` for app setup and its separate acceptance checks.

## Authenticated resolution RPC

`resolve_teacher_review(review_id uuid, action text)` returns the resolved teacher_reviews row
as an array. Migration 004 added it with demo-only authorization; migration 006 replaced that:
the caller must be signed in and must own the review's session (`sessions.teacher_id =
auth.uid()`). Reviews are readable only by that owner, and a historical session with no owner
cannot be resolved from a browser. The only actions are `confirmed` and `dismissed`: the
statuses `expired` (closed when the session ended or the task was completed) and `reviewed`
(a teacher used Mark as reviewed) are set only by the database. Timestamps are generated by
the database, and direct browser writes remain denied. SQL smoke:
`supabase/tests/resolve_teacher_review.sql`. See `notes/michelle.md` for non-service
authenticated RPC and Realtime verification.

## Teacher reviews

Apply `supabase/migrations/20261114000300_teacher_reviews.sql` after the first two migrations
using the Supabase SQL Editor (or `supabase db push` for a linked CLI project).
This adds `public.teacher_reviews`, its indexes, RLS and lifecycle trigger, and
membership in `supabase_realtime`. Applied and verified on the hosted `cues`
project on November 14, 2026; do not reapply it there. See
`notes/michelle.md` for the hosted verification results.

The table persists the existing Python `TeacherReview`: UUID, creation time,
session/seat/activity, priority, complete evaluation JSON, assessment decision,
rationale, structured evidence labels, status, and resolution time. Only status
and resolved_at may change, and only once, from pending to confirmed, dismissed, expired or
reviewed (the last two are set only by the database: see Review lifecycle and Mark as
reviewed).
The database guard applies to service-role updates too. An identical evaluation
is unique across backend instances; duplicate inserts do not rewrite an assessment
or reopen a resolved review.

The backend composition point is `agent.runtime.create_runtime_agent(model, history)`.
It uses the shared server client factory and injects SupabaseTeacherReviewStore
when SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are configured. Nonempty process
values win over root .env, with web/.env.local as a local fallback; that file's
NEXT_PUBLIC_SUPABASE_URL may supply the URL alongside the server-only key. No new
credentials are needed. Startup checks table access and fails on partial/broken
persistence configuration. Write failures never silently fall back to memory.
The core agent factory remains in-memory by default for direct unit/offline use;
the runtime exposes offline=True, and the live Groq runner has --offline-reviews.
The continuous agent.worker polls seat_state through create_seat_state_runtime.
FastAPI serves vision/video; there is no agent API server. See STARTUP.md.

Optional runtime/action smoke (scripted model, real Supabase, isolated probe cleanup):

```bash
uv run python -m agent.hosted_review_smoke
```

This passed against the hosted project on November 14, 2026. Normal unit tests
remain network-independent. Details are in `notes/michelle.md`.

The dashboard fetches its initial rows and subscribes to INSERT/UPDATE Postgres Changes on
`public.teacher_reviews`. Since migration 006 a review is readable only by the teacher who owns
its session (`own_teacher_reviews_read`); the earlier demo read policy was dropped and anonymous
reads were revoked. See [Supabase Postgres Changes](https://supabase.com/docs/guides/realtime/postgres-changes)
for publication and subscriber read-permission requirements.

Anon/authenticated clients receive no direct INSERT/UPDATE/DELETE privileges. A signed-in
teacher may call `resolve_teacher_review` for reviews of their own sessions; anonymous callers
cannot. Never send a service-role key to the frontend.

Optional SQL smoke, after applying migrations, with a database-owner connection:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/teacher_reviews.sql
```

This creates synthetic fixtures inside a transaction and rolls them back. Written against
migration 003 (migration 006 later made reads owner-only), it checks demo RLS, denied anonymous writes, immutable trusted fields, both resolution
statuses, rejected re-resolution, and Realtime publication membership. Validated
locally on PostgreSQL 14 and against the hosted project. A public-key subscription
received real INSERT/pending and UPDATE/confirmed or dismissed events; the
isolated synthetic API probe rows were removed afterward.

## Session ownership on start (migration 007)

Migration 006 adds `sessions.teacher_id` and makes `teacher_reviews` readable only for
sessions the signed-in teacher owns, but `start_station_activity` still created sessions
without an owner. Migration `20261114000700_session_owner_on_start.sql` sets
`teacher_id = auth.uid()` when the RPC creates a session; activity changes keep the
existing owner, and historical sessions stay unowned. The browser never sends a teacher
ID; it only checks that a new session came back owned by the signed-in user. Apply it
after 006. Not applied to the hosted project. SQL smoke (rolls back):
`supabase/tests/session_owner_on_start.sql`, not yet run (no local Postgres).

## Approved interventions (migration 018, not yet applied)

`20261114001800_interventions.sql` builds the approved-intervention workflow (PRD §12, §13, §26).
The agent may attach **one** suggested support to the review it requests, and only from a fixed
menu of six (`repeat_instruction`, `show_example`, `model_task`, `smaller_steps`, `offer_break`,
`adult_check_in`). The same keys are in `shared/contracts.py` (`INTERVENTION_MENU`),
`web/lib/interventions.ts` and the migration, and a test keeps them equal.

- `teacher_reviews.suggested_intervention`: nullable, checked against the menu. Written by the
  agent only when `agent.interventions` is on and it chose one.
- `interventions.review_id` (unique per review) and a menu check on `action`. A teacher can read the
  approvals of reviews in sessions they own; nobody writes the table directly.
- `approve_review_intervention(review_id, action default null)`: owner-only. The action defaults to
  the agent's suggestion; the teacher may pick any other menu item. A pending review becomes
  `confirmed` in the same step; closed reviews (`dismissed`, `expired`, `reviewed`) cannot be
  approved, and a review can be approved once.

Nothing changes a student's task or an instruction: the approval is the teacher's record. Tests:
`supabase/tests/test_interventions.py` (11 cases on a real PostgreSQL). Apply it only with the
usual dry run first (`scripts/supabase-migrations.py dry-run`, then `push`), before turning either
flag on: the agent writes the new column and the dashboard selects it.
