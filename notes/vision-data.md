# Vision data handoff

Canonical exchanged fields are defined in `shared/contracts.py`; SQL migrations
under `supabase/migrations/` define persistence. See [Keith's notes](keith.md)
for perception and [Michelle's notes](michelle.md) for consumption.

## Primary feed: seat_state

Vision upserts one latest row per seat_id, on status/tracking changes and otherwise
about once per second. Fields: seat_id, session_id, activity_id, status,
updated_at, tracking_valid, session_revision, task_score, expression_context.
updated_at is the observation time, not the network send time. session_revision is the
session revision the observation was made under; the database rejects writes that do not match
the station's active session, revision and activity (managed stations).
`seat_state.evaluated_progress` is written only by the agent (migration 012); vision's upserts omit it.

tracking_valid is nullable: true is a valid current observation, false is missing
tracking, null is unknown historical state. Invalid tracking publishes null
task_score; it never counts as student failure. Migration 005 added the nullable
boolean without a default and was verified through live publisher upserts.

Expression is supporting-only. Qualifying sustained context includes label,
probability and duration_seconds; otherwise it is null. No frames or images go
to Supabase or the LLM.

## Consumers and task selection

The continuous worker polls seat_state and runs ProgressEvaluator → progress
history recording → EscalationEvaluator → EvaluationRouter → ContextEnricher
→ Deep Agent → persistent teacher_reviews. New persisted reviews can notify through
Photon/Spectrum; teacher resolution uses the authenticated Supabase RPC.

## Station, session and person ids

Vision works for one station, set by the signed-in teacher's dashboard (`POST 127.0.0.1:8000/config`,
loopback only) or pinned with `CUES_STATION_ID` for dev/test. Until a station arrives it tracks people
for the local video only and writes nothing. With the session lifecycle on (the launcher default) it
follows the station's active session, activity and revision from Supabase once per second
(`vision/session_sync.py`); an ended session, a failed read or an expired seven-second lease pauses
task evaluation and writes. A pause keeps each person's status (holds and timers skip the paused time); only a new session or
revision starts everyone over. `CUES_SESSION_ID` is not used for managed frames.

Person ids are `<station>-P<n>`: `S1-P1` to `S1-P4`, `S2-P1` and so on, by position only (no face
recognition). A new station starts with a fresh tracker. Simulated person slots for each station exist
in `seats` (migrations 510 and 011), which is what lets the dashboard read their state. Do not assume
fixed seat counts or persistent student identity: a person who leaves for over ten seconds, or two
people who swap places, can change ids.

## Mark as reviewed (vision reads, never writes)

When a teacher uses Mark as reviewed, the database records a row in `seat_review_marks` (migration 015).
With `vision.review_marks` on (the default), vision polls those marks for the active session
(`vision/review_marks.py`) and puts a marked child back to `in_progress`, restarting the no-progress
and review timers; a completed task stays `done`. Marks that exist when a tracker is created do not
reset it. Vision reads only a seat id and a time.

## One camera per station

Each vision process claims its station with a random writer id (`claim_station_writer`, migration 017)
before reading the session, and renews the lease about once a second. A second camera is refused: it
pauses completely, retries each second, and takes over when the first stops (it releases at once) or
crashes (the lease expires after 10 seconds). `GET /config` reports `station_busy`. Without the
migration vision keeps working with no guard and warns once.

## Local service endpoints

All on `127.0.0.1:8000`, local only. `GET /health` (camera, frame rate, stages, every vision flag);
`GET /stream` (MJPEG video); `GET`/`POST /config` (the station; loopback only, JSON only);
`/gestures` and `/templates/*` (teacher-recorded gestures, below).

## Other outputs and local video

Events are informational audit/debug observations, not the primary routing feed.
The background emitter falls back to local event JSONL and latest-state JSON
when cloud publication is unavailable. Gesture templates stay local.
MJPEG /stream is the intentional local demo transport; WebRTC is not required.

Setup and env details: [STARTUP](../STARTUP.md). Product authority:
[PRD](PRD-cues.md). Use simulated data only.

## Teacher-recorded gestures (dashboard API, for Evan)

Vision exposes a local HTTP API so the dashboard can let a teacher add a new
gesture by recording it. No UI is built yet; this section is the contract.

Turn it on in the root `.env`: `CUES_FLAG_VISION_CUSTOM_GESTURES=1` (the
`/templates` recording routes are on whenever `vision.gestures` is on, which
`./scripts/dev.sh` already enables). Base URL: `http://127.0.0.1:8000`. The
browser may call it directly from `http://localhost:3000` (CORS); other origins
can be allowed with `CUES_DASHBOARD_ORIGINS` (comma-separated).

| Call | Body | Returns |
|---|---|---|
| `GET /gestures` | | list of gesture objects (below) |
| `POST /gestures` | `{"name": "Wave", "keywords": ["wave"]}` (keywords optional) | 201, the new gesture; 422 if the name has no letters/digits |
| `POST /templates/record` | `{"activity_id": "custom_wave", "label": "target" or "rest", "seconds": 2, "seat_id": "S1-P1"}` (`seconds` 0-10, default 2; `seat_id` optional, default the largest hand in view) | `{"captured": 18, "activity_id", "target_examples", "rest_examples", "rejection_threshold"}`; 422 if no hand was seen |
| `GET /templates/{id}` | | the same counts |
| `DELETE /templates/{id}` | | clears that gesture's examples (re-record) |
| `DELETE /gestures/{id}` | | removes a dashboard-created gesture and its examples; 404 for catalog gestures |

Gesture object:

```json
{"id": "custom_wave", "name": "Wave", "builtin": false, "custom": true,
 "success_threshold": 0.78, "review_threshold": 0.58,
 "target_examples": 18, "rest_examples": 12, "ready": true}
```

Built-in gestures (thumbs_up, open_palm, pointing, peace, fist) have
`builtin: true`, `ready: true` and null example counts; they cannot be recorded.

Suggested teacher flow:
1. Teacher types a name -> `POST /gestures`; keep the returned `id`.
2. "Show the gesture": show a 3-2-1 countdown in the UI, then
   `POST /templates/record` with `label: "target"`. The request blocks for
   `seconds` while vision samples the live camera. Do this 3 times, asking for
   a slightly different angle each time. Show `captured`; if 422, ask the
   teacher to keep the whole hand in view.
3. "Relax your hand / show other gestures": 2 takes with `label: "rest"`.
4. `ready` is true: the gesture is detected live immediately (green on the
   video, and in `seat_state` / events when it is the current task).

Notes:
- Recording uses the running service and camera; nothing needs restarting.
  `agent.worker` reads the catalog at start, so restart the stack before
  assigning a new gesture as the current task.
- The id must also exist in the Supabase `activities` table before
  `sessions.current_activity_id` can point at it (insert `id`, `name`,
  `check_type: "gesture"`, thresholds from the gesture object).
- Privacy: only the gesture name goes to Supabase. The definition and the hand
  examples stay in `vision/templates/` on the laptop (git-ignored). The API
  never returns images or landmarks.

## Vision flags

Generated from `flags.json` (override with `CUES_FLAG_VISION_<NAME>=1|0`; the launcher turns the perception stages on).

| Flag | Default | What it does |
|---|---|---|
| `vision.supabase_events` | off | Send vision events and seat_state to Supabase. When off, they are written only to vision/logs/*.jsonl. |
| `vision.hands` | off | MediaPipe hand tracking, with each hand assigned to a seat. |
| `vision.faces` | off | MediaPipe face detection and the face crop per seat. |
| `vision.gestures` | off | Gesture match score per seat against the teacher's recorded examples. |
| `vision.expression` | off | HSEmotion facial-expression context per seat (supporting evidence only). |
| `vision.raise_hand` | off | Raise-hand rule per seat: a wrist above that seat's face, held briefly. |
| `vision.task_status` | off | Per-seat task status and events (attempt_success, attempt_miss, review_needed, no_progress, tracking_lost, expression_context). |
| `vision.activity_sync` | off | Read the current task from Supabase sessions.current_activity_id instead of CUES_TASK. |
| `vision.session_lifecycle` | off | Follow teacher-managed station sessions, pin frame IDs and pause task processing on session end or sync loss |
| `vision.all_scores` | off | Display-only readout of every task's score for every person (overlay and vision.watch). Not sent to Supabase. |
| `vision.custom_gestures` | off | Dashboard API to create teacher-recorded gestures (/gestures). Definitions and examples stay in vision/templates/ on this laptop. |
| `vision.station_config` | on | Local /config endpoint: the signed-in teacher's dashboard sets this laptop's station. Vision writes nothing until a station is set. When off, the station is S1 (or CUES_STATION_ID) as before. |
| `agent.interventions` | off | The agent may attach one suggested support from the approved intervention menu to a review request. Needs migration 018; the teacher approves before anything is recorded. |
| `agent.live_progress` | off | Publish guarded live progress summaries after migration 012 deploys. |
| `vision.review_marks` | on | Read the teacher's Mark as reviewed marks so a flagged child goes back to working and the no-progress timer restarts. Reads only seat ids and times from Supabase. |
