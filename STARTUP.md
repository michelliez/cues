# Local startup

Use Python 3.11 with uv, Node 22+ and npm, a Logitech camera with OS camera
permission, and configured hosted Supabase/Spectrum projects.

Documentation lives in `notes/` (start at [notes/README.md](notes/README.md)); only this file,
`README.md`, and the tool-bound `CLAUDE.md` / `AGENTS.md` sit at the repo root.

```bash
uv sync
npm --prefix web ci   # also installs cues/ (postinstall), which the web server imports for Photon sends
./scripts/dev.sh
# Short presentation timings:
./scripts/demo.sh
```

Both wrappers use scripts/run-stack.sh and the same agent.dev supervisor to start
vision on port 8000, agent.worker, and Next.js on port 3000.
Dev uses the existing normal runtime defaults (4-second progress window,
5-second minimum observation, 10-second normal and 15-second prolonged stall).
Demo selects the existing DEMO_PROGRESS_WINDOW_SECONDS and DEMO_ESCALATION_CONFIG:
2-second window/minimum, 4-second normal, 5-second expression-assisted and
6-second prolonged stall. Expression persistence remains five seconds. Demo
timing is for presentation speed, not a classroom recommendation.
Demo polls SeatState every 0.5 seconds (plus request time) against vision's roughly
one-second heartbeat; dev retains one-second polling. This reduces skipped rows
that could exceed the evaluator's unchanged two-second observation-gap limit.
Agent logs show the selected profile and only changes to progress/escalation,
including tracking, score, observation age/gap and routing outcome. "Working" is
vision's status; the agent's internal stalled state does not rewrite seat_state.
Component logs are prefixed. Ctrl-C/SIGTERM stops all isolated process groups,
with SIGKILL for surviving groups after a shared five-second grace period,
even if their direct child has exited. Direct children are reaped. A component exit stops
the stack. Photon runs on demand; no separate Photon daemon is started.
The launcher does not apply migrations or create demo data.

## Environment

Root `.env` (backend only; never commit credentials):

| Variable | Use |
|---|---|
| `SUPABASE_URL` | Required project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Required privileged server credential |
| `GROQ_API_KEY` | Required demo model key |
| `CUES_SESSION_ID` | Optional legacy/smoke session UUID; not used by managed startup |
| `CUES_STATION_ID` | Dev/test override only. Normally unset: the signed-in teacher's dashboard sends its station to vision |
| `CUES_CAMERA_INDEX` | Optional camera index, default 0; USB often 1 |
| `CUES_CAMERA` | Optional `fake` for camera-free startup |
| `CUES_FLAG_<AREA>_<NAME>` | Override any flag in `flags.json` (`1`/`true` or `0`/`false`), for example `CUES_FLAG_VISION_EXPRESSION=0` |
| `CUES_USE_STATIC_TEACHER_PHONE` | `0` (dynamic, from the session owner's profile) or `1` (the test number in `cues/.env`); `demo.sh` forces `0` |
| `CUES_DASHBOARD_ORIGINS` | Optional, comma-separated browser origins allowed to call the local vision service; default `http://localhost:3000` |
| `DATABASE_URL` | Only for `scripts/supabase-migrations.py` (applying migrations); never needed to run the stack |
| `CUES_OVERLAY` | `debug` draws every stage's own detail on the video instead of the normal overlay |
| `CUES_NO_PROGRESS_SECONDS` | Shortens the "no progress" wait (default 3s for gesture tasks, 30s for raise hand); it never lengthens one. `./scripts/demo.sh` sets it to the agent's demo stall time (4), so raise hand flags at 4s and gestures stay at 3s |
| `CUES_GESTURE_NO_PROGRESS_SECONDS` | How long a person may be Working on a gesture task (built-in or recorded) before they read Needs Review (default 3). Set `30` to go back to the old wait. Only time Cues can judge counts: a hand it cannot score (no recorded examples) does not, but with `vision.flag_on_time_on_task` (on by default) all time on the task counts (tracking loss excluded), so anyone still working after the wait reads Needs Review. After Mark as reviewed the child gets at least 15s before being flagged again |
| `CUES_PALM_FLIP` | `1` swaps palm and back of hand if a camera mirrors its output |
| `CUES_SPECTRUM_DEBUG` | Optional extra logging from the notification sender |

Both modes default hands, faces, gestures, raise-hand, expression, task-status,
Supabase publication, activity-sync and session-lifecycle flags ON. Shell values take priority over
root .env; saved nonempty root .env flag values take priority over defaults.
For example:

```bash
CUES_FLAG_VISION_EXPRESSION=0 ./scripts/demo.sh
CUES_CAMERA=fake ./scripts/dev.sh
```
For the current Logitech setup use `CUES_CAMERA_INDEX=1`; other machines may need
0 or 2. Gesture detection (every known gesture, shown green on the video when
completed) is always on; there is no separate mode.
Weights may download on first use. Fake frames do not simulate student progress.

`web/.env.local`: browser-safe `NEXT_PUBLIC_SUPABASE_URL` and
`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`. The dashboard's screens are flags (see
`flags.json` and [notes/web.md](notes/web.md)): the sign-in, landing and profile screens and the
dashboard default on, and so do session controls, teacher reviews, review actions, person
observations, the To review page and the camera health strip. Turn one off with its
`CUES_FLAG_WEB_…=0` (for example `CUES_FLAG_WEB_SESSION_CONTROLS=0`). Interventions, live
progress and the hosted local feed default off. `CUES_STATION_OVERRIDE` pins the dashboard to one station
for dev/test only. Never expose service-role, Groq, or Spectrum credentials as `NEXT_PUBLIC_*`.

`cues/.env`: backend-only `SPECTRUM_PROJECT_ID`, `SPECTRUM_PROJECT_SECRET`,
`SPECTRUM_TEACHER_PHONE` is test-only; optional `SPECTRUM_SENDER_PHONE` selects the line.
Testing = static mode 1: `CUES_USE_STATIC_TEACHER_PHONE=1 ./scripts/dev.sh` uses
the env destination. Actual demo = dynamic mode 0: `./scripts/demo.sh` forces 0,
even if the shell or env requests 1. Dynamic mode ignores the static destination
and resolves review.session_id → sessions.teacher_id → teacher_profiles.phone_number.
Missing owner/profile/phone fails notification clearly and retains the pending review.
There is no static fallback. Add the opted-in profile destination to active Spectrum Users.
The sender loads this file relative to its module, independent of working directory.
The agent worker reads `cues/.env` again on every send, so saving or fixing it
takes effect on the next review without a restart. Until it is complete, the worker
logs a startup warning and each review logs "Teacher notification failed … (Spectrum
project credentials are missing …)"; persistence and review processing still run.
Each failed send logs a safe reason (no phone, secret or provider detail).

## Database and demo prerequisites

Local repair migration `20261115000100_review_resolution_marks.sql` must be
deployed before using the dashboard's review-reset fix. It makes a confirmed or
dismissed review answer acknowledge the active camera task atomically. It has
not been applied to the hosted project; see `notes/supabase.md` for rollout and
local verification. The existing RPC signature and vision/worker readers remain
compatible.

Camera-only support choices additionally require local migration
`20261115000200_teacher_flag_decisions.sql`, applied after the review-reset repair.
It has not been applied to the hosted project. `web.flag_decisions` defaults off:
the UI offers Mark as reviewed until the migration and live RPC are verified.
Then set `CUES_FLAG_WEB_FLAG_DECISIONS=1` in the web environment and rebuild/restart
to enable distinct, durable Support needed / No support needed answers. See
`notes/bugfix-implementation-log.md` for the implementation and verification record.

The first 20 migrations in `supabase/migrations/` (000100 through 001700) are applied to the hosted
project. Migration 001800 (approved interventions) is written and tested but **not applied**; it is
needed only by the `agent.interventions` and `web.interventions` flags, which are off. A new project applies them in filename order; see
[notes/supabase.md](notes/supabase.md) for what each adds, how to apply them
(`scripts/supabase-migrations.py list|dry-run|push`) and their tests. The launcher does not
apply migrations or create demo data. Do not reapply the initial schema to the hosted project.

Nothing is provisioned by hand. A teacher signs in, the dashboard finds or creates their own
default station, and they start and end sessions from Session controls. The activity list
comes from the `activities` table: `raise_hand`, plus the built-in gestures (thumbs up, open
palm, pointing, peace, fist) from migration 014 and `supabase/seed.sql`. Worker startup converts
`vision/activities.json` into shared Activity models; restart after catalog edits (unknown ids
are skipped and logged). A gesture a teacher records on the laptop is not in `activities` yet,
because there is no dashboard screen for it (see [notes/outstanding-work.md](notes/outstanding-work.md)).

Review reads and resolution are owner-only (migration 006): a review is readable and
resolvable only by the teacher who owns its session; historical sessions stay unowned. Dev
permits a static phone override for testing. Demo forces dynamic mode, which needs the session
owner's teacher profile and saved phone (the dashboard creates both).

## Endpoints and readiness

- Dashboard: http://localhost:3000
- Vision health: http://127.0.0.1:8000/health
- Local video: http://127.0.0.1:8000/stream (keep local)

A healthy vision demo reports an open camera and zero startup errors at /health.
The launcher surfaces component errors and stops when a required process exits;
it does not wait indefinitely for camera health.

Before demo: connect camera, check Supabase connectivity/current session/activity,
verify dashboard availability and test backend review resolution with teacher authentication, verify Groq key and
Spectrum target activation, and check person-ID visibility.
Camera-free development: `CUES_CAMERA=fake ./scripts/dev.sh`.

## Troubleshooting

The launcher stops this repo's leftover dashboard, vision and agent-worker processes when it
starts (a closed terminal used to leave them running), and it shuts everything down cleanly on
Ctrl-C, kill or a closed terminal. It never touches another project's server.

Old rows in `seat_state` (the retired S1-L and S1-R seats, and people from finished sessions):
`uv run python scripts/cleanup-seat-state.py` lists them (a dry run). Add `--delete` to remove them,
after it asks you to confirm.

Notification activation is manual for the hackathon. The teacher opts in under
/settings/profile; Cues records consent against the saved profile phone and shows
“Notifications: activating”. The operator adds/invites that recipient through the
Photon/Spectrum website, preserving the provider's eligibility restrictions.
No Photon CLI provisioning or dashboard OAuth credentials are used by Cues.

POST /api/notifications/register requires a verified Supabase bearer user and JSON
{"opt_in":true,"first_name":"...","last_name":"..."}. It records consent and queues
manual activation, returning HTTP 202/status pending. Deployed migration 009's
registering status represents that request. opt_in:false revokes consent.
No browser-supplied UUID, email or phone is accepted.

After website activation, click **Send test notification** under /settings/profile.
POST /api/notifications/test accepts no destination/identity fields: the verified
bearer user, saved profile phone and current consent attempt are resolved server-side.
An accepted test or real review send automatically records registration. Pending
registration no longer blocks sending when opt-in, phone and project match.
“Target not allowed” leaves Notifications: activating; finish website activation
and retry. Other failures store only safe categories and never remove a review.
No manual Supabase registration SQL or admin UI is required.

Migration 010 (the backend-only atomic acknowledgement RPC) is applied, like the rest. The Next
server uses the root .venv Python and nested cues sender; run the existing Python/Node setup
before testing.

Runtime message sending continues to use SPECTRUM_PROJECT_ID and
SPECTRUM_PROJECT_SECRET in cues/.env. Phone changes invalidate consent and
registration; the new phone needs fresh opt-in and operator activation.
Registration status is not a delivery or read receipt.

Dynamic review notifications now require current-phone consent and successful
registration in the same Spectrum project. Missing migration/settings/consent
fails closed while preserving pending reviews. Static test mode is unchanged.

- Missing `tracking_valid`: apply migration 005 to the correct project.
- `Target not allowed for this project`: activate teacher destination in Spectrum Users.
- Missing Supabase configuration: set root backend variables; public keys are insufficient.
- Camera unavailable: check OS permissions/index or use fake mode.
- Port collision: the launcher automatically stops previous Cues Next.js/vision
  listeners on 3000/8000 after verifying their command and project directory.
  Unrelated or unidentified listeners are left running with a clear error.
- Photon env missing: save `cues/.env`, check required names and install nested dependencies.
- Unknown activity: align catalog with vision and restart worker.
- "Station is in use by another camera" in the vision log: a second camera is working for the
  same station (the same account signed in on two laptops, a pinned `CUES_STATION_ID`, or old
  code). Close the extra one or sign in on that laptop with its own account.
- The dashboard still shows a child as Needs Review after "Mark as reviewed": vision (with
  `vision.review_marks` on, the default) must be running and on the session lifecycle.

### Dynamic station runtime

Both launch modes enable `vision.session_lifecycle` by default; an explicit flag
value still overrides it. Managed startup requires backend Supabase/Groq credentials,
not `CUES_SESSION_ID`. That variable is only for explicit legacy/smoke commands.
Leave root `CUES_STATION_ID` and web `CUES_STATION_OVERRIDE` unset for normal demos.

Each teacher account has one persistent default station, created the first time they sign in
(migration 011; Keith keeps S1). The dashboard sends that station to this laptop's vision
service (`POST 127.0.0.1:8000/config`, loopback only), so each laptop's camera follows its
own signed-in teacher; vision writes nothing until a station arrives. Users with several
memberships and no default get their own new station and keep the others.

Only one camera can use a station at a time (migration 017): a second camera is refused,
logs "in use by another camera", pauses (reads and writes nothing), and takes over when the
first stops. The dashboard shows a warning while that is happening. A laptop on older code
ignores the guard, so everyone should run the same revision.

The worker reads the local vision `/config` assignment, then only that station's
active session, matching activity/revision and seat IDs. Missing vision/station or
an ended session pauses consumption. Task revision changes reset progress/router
state. Dashboard and connected Live feeds pause until station resolution succeeds.
Vision handoff failures appear in session controls; signing out clears an unpinned
vision assignment. Photon continues to resolve the review session's owner.

### Live evaluated progress

Migration `20261114001200_live_progress.sql` adds the guarded agent-owned summary.
After deployment, enable `CUES_FLAG_AGENT_LIVE_PROGRESS=1` in root `.env` and
`CUES_FLAG_WEB_LIVE_PROGRESS=1` in `web/.env.local`, then restart the stack.
Both flags default off for safe rollout. Vision status remains separate from evaluated
trend. Missing/stale/invalid-tracking evaluations display unavailable rather than invented
stall time. See `notes/pipeline-audit.md` for the complete connection audit.

### Hosted dashboard with a local camera

The hosted UI can connect directly to this laptop's loopback vision service when
`web.hosted_local_feed` is enabled. Set
`NEXT_PUBLIC_CUES_FLAG_WEB_HOSTED_LOCAL_FEED=1` in Vercel Production and redeploy.
The allowed frontend origin defaults to `https://cues.nyc`; override explicitly with
`NEXT_PUBLIC_CUES_HOSTED_ORIGIN` when using another trusted production domain.
In the laptop's root `.env`, set
`CUES_DASHBOARD_ORIGINS=http://localhost:3000,https://cues.nyc` and restart vision.
Keep the service bound to 127.0.0.1. Run dev/demo on the same laptop as the browser,
open cues.nyc, and click Turn on video. Allow the browser's Local Network Access
permission if prompted; if denied, change the site's permission and retry.
If the hosted page still says it can't reach the camera: restart Cues after editing `.env` (vision reads
`CUES_DASHBOARD_ORIGINS` only at start), run it on the same laptop as the browser, use Chrome or Edge,
and check Local network access for cues.nyc in the browser's site settings. Vision answers the
browser's private-network preflight only for the origins listed there.
Hosted video never autoconnects from a remembered setting. Frames go directly from
loopback to the browser, never through Vercel. No wildcard origins, public camera
endpoint, or tunnel is configured. Vercel does not host the camera or agent process.
