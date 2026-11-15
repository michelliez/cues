# Cues — Product Requirements Document

*HackPrinceton Fall 2026 · 36-hour build · Version 2*

---

## 1. Product summary

**Cues** is an AI-powered classroom support system for special education (SEN) settings.

In classrooms where one teacher is responsible for many students moving at different speeds, the teacher cannot continuously watch every student. Cues uses a camera to observe simple, teacher-defined physical tasks, track whether a student is making progress, and surface timely cues about who may need help.

Cues is designed to **assist the teacher, not replace them**. Computer vision handles simple, observable signals; a rules layer decides when an event is meaningful; an AI support agent gathers context and decides which approved tools to use; and the teacher remains in control of any instructional change.

### Core product loop

1. Teacher activity selection uses sessions.current_activity_id; dashboard write
   controls remain a frontend integration gap in the current checkout.
2. Local MediaPipe and HSEmotion publish structured seat_state observations.
3. ProgressEvaluator → EscalationEvaluator → EvaluationRouter → ContextEnricher
   selects meaningful stalled-progress episodes for the Deep Agent.
4. The agent adaptively retrieves history and may call request_teacher_review().
5. A pending review persists in Supabase teacher_reviews and triggers a minimal
   Photon/Spectrum iMessage notification.
6. The teacher chooses Support needed or No support needed through the review workflow.

Video stays local; the LLM receives no camera frames or images.

---

## 2. Problem & motivation

In SEN classrooms, students can have very different communication, motor, sensory, and learning needs. One teacher may need to support many students simultaneously, making it difficult to notice immediately when an individual student has completed a task, is repeatedly struggling with it, or may need assistance.

Practitioner input gathered for this project indicates that:

- wearable devices may be uncomfortable or impractical for some learners;
- camera-based sensing is less intrusive for simple classroom tasks;
- simple observable actions such as hand gestures can be evaluated more reliably than complex multi-step activities;
- automation should route teacher attention rather than attempt to replace teacher judgment.

Cues addresses this as an **attention-routing problem**.

The product does not attempt to determine a student's diagnosis, intent, or internal emotional state. Instead, it combines observable task-progress signals with optional facial-expression evidence and uses those signals to help the teacher decide where to look next.

---

## 3. MVP scope

The implemented MVP combines local person tracking, task-specific gesture and
raise-hand checks, optional supporting expression context, structured SeatState
publication, continuous progress evaluation, adaptive agent tools, persistent
teacher reviews, and deterministic teacher resolution.

Teacher activity selection uses dashboard controls and sessions.current_activity_id.
Voice/push-to-talk is optional future work, not required by the current demo.
Custom static gesture templates remain local; built-in thumbs-up needs no recording.

The system routes teacher attention. It does not diagnose, infer internal
emotional state, identify students biometrically, or automatically change
instruction. Tracking loss is not student failure. Use simulated data only.
Object recognition, physical controls, curriculum planning, autonomous
interventions and cloud video processing remain outside this MVP.

---

## 4. Current technology stack

| Component | Technology |
|---|---|
| Dashboard | Next.js + Tailwind |
| Local perception | MediaPipe Pose/Hands/Gesture Recognizer; HSEmotion ONNX |
| Camera | Logitech C930e |
| State and reviews | Supabase Postgres + Realtime |
| Agent | LangChain Deep Agents |
| Demo inference | Groq openai/gpt-oss-20b |
| Local vision/video API | FastAPI |
| Teacher notifications | Photon 2.0 through Spectrum iMessage |

The core agent accepts an injected model and remains provider-independent.
The continuous agent is a Python worker, separate from the vision FastAPI service.
See STARTUP.md for operational configuration.

---

## 5. Architecture

### 5.1 High-level architecture

 ```mermaid
flowchart TD
    A[Teacher dashboard activity selection] --> B[sessions.current_activity_id]
    B --> C[Local vision]
    D[Logitech camera] --> C
    C --> E[Supabase seat_state]
    E --> F[ProgressEvaluator]
    F --> G[EscalationEvaluator]
    G --> H[EvaluationRouter]
    H --> I[ContextEnricher]
    I --> J[Deep Agent]
    J --> K[request_teacher_review]
    K --> L[Supabase teacher_reviews: pending]
    L --> M[Dashboard review queue]
    L --> N[Photon / Spectrum iMessage]
    M --> O[Teacher: Support needed / No support needed]
    O --> P[resolve_teacher_review RPC]
    P --> Q[confirmed / dismissed]
```

### 5.2 Architecture principles

**Local perception first.**  
Camera frames are processed on the station laptop.

**Events, not video.**  
Only structured task events, match scores, timestamps, and necessary contextual values are sent to Supabase.

**LLM only on meaningful events.**  
The Deep Agent is not called on every frame or every attempt. The rules engine invokes it only when the system has enough evidence that teacher attention may be useful.

**LLM never sees camera frames.**  
The model receives structured state such as:

```json
{
  "seat_id": "S1-L",
  "task": "custom_gesture_01",
  "recent_attempts": ["miss", "miss", "miss"],
  "time_on_task_seconds": 34,
  "gesture_match_scores": [0.31, 0.38, 0.35],
  "expression_context": {
    "label": "sadness",
    "probability": 0.63,
    "duration_seconds": 6,
    "supporting_only": true
  }
}
```

It does **not** receive images.

---

## 6. Local vision service

The station laptop runs a Python vision service responsible for webcam capture, local model inference, task matching, and event generation.

### 6.1 Camera

- Logitech C930e (1080p, 16:9, 90° field of view), chosen during the build for its wide view of a table of children.
- The camera is asked for 1280×720; every frame is processed at **960×540 (16:9)** without cropping, so children at the edges of the wide view stay in frame. A 4:3 camera would lose its top and bottom edges rather than be stretched.
- Hand shapes, finger checks, shoulder width and hand-to-person distances convert x by the frame's aspect ratio, so scores do not depend on the frame shape. Recorded custom gestures carry a format version and must be re-recorded after a camera change.
- Measured on the station laptop (synthetic frames): all models together ≈ 13 ms per frame at 960×540, well above the camera's 30 fps.
- Select the camera with `CUES_CAMERA_INDEX` (on a Mac with a built-in camera, the USB camera is usually 1).
- Target a smooth enough frame rate for interaction rather than maximum throughput.
- The vision service owns webcam access to avoid multiple processes competing for the device.

### 6.2 Person tracking (replaces fixed seat zones)

*Changed during the build (Keith). The fixed left/right seat zones were removed. Dashboard and schema changes this needs are Evan's to make; see §15.1 and §17.5.*

One camera follows up to four people. Vision does not split the frame into fixed halves.

1. MediaPipe Pose Landmarker (video mode) finds each person and their body points.
2. A tracker keeps one id per person across frames: `S1-P1`, `S1-P2`, … (`<station>-P<n>`). The id is based on position only. There is no face recognition and nothing about who the child is is stored.
3. Each MediaPipe hand is assigned to the person whose pose wrist is nearest. Each face is assigned to the person whose pose nose is inside it.
4. Each person counts **one hand**: for gesture tasks, the hand that best matches the gesture; for raise-hand, the highest hand.
5. A person out of view for 3 s gets `tracking_lost`. After 10 s their id is released and may be reused, so a child who leaves and returns can get a new id.

The previous `seat_id` field keeps its name in every contract and table, but now holds a person id.

### 6.3 Station video overlay

The live camera picture stays on the station laptop. The vision service serves it at `http://127.0.0.1:8000/stream`; the dashboard's "Live classroom" panel shows it only on that laptop, loaded directly from the local service, never through Supabase or the cloud.

The overlay draws, for each person, in that person's colour:

- a box around the face, labelled with the id and the strongest expression probability, e.g. `P1  neutral 0.61` (model output, not an emotional state);
- that person's one hand: the full hand skeleton and a box around it, labelled with the task score, e.g. `raise_hand 0.82`, coloured green (at or above the success threshold), orange (review band) or grey (below);
- a thin line from the hand's wrist to the face box, showing whose hand it is.

If a face is not visible, only the hand box is drawn, labelled with the id (`P1  raise_hand 0.82`). No body box is drawn. Detailed per-stage drawings are available for debugging only.

---

## 7. Hand tracking and gesture matching

### 7.1 MediaPipe Hand Landmarker

For each detected hand, store the 21 hand landmarks.

Each hand contains:

```text
21 landmarks × (x, y, z) = 63 values
```

### 7.2 Landmark normalization

Before gesture comparison:

1. translate the wrist landmark to the origin;
2. scale coordinates relative to hand size;
3. consistently mirror left/right hands if needed;
4. flatten the normalized landmarks into a 63-dimensional vector.

This makes matching less sensitive to image position, distance from the camera, and handedness.

### 7.3 Teacher-defined gesture recording

The teacher selects an activity and records 3–5 examples of the target gesture.

The system stores normalized landmark vectors locally.

The teacher can optionally record examples of “rest / other” hand states to improve rejection of unrelated poses.

Templates remain on the local station.

### 7.4 Nearest-neighbor matching

For a new hand pose:

```text
d_target = distance to nearest target example
d_other  = distance to nearest other/rest example
```

A gesture is considered a candidate match when:

```text
d_target < calibrated_target_threshold
AND
d_target < d_other
```

if an `other/rest` class exists.

### 7.5 Match score

The UI shows a **match score**, not a probability.

The score is derived from the distance between the observed normalized landmark vector and the nearest target template.

Example form:

```text
match_score = clamp(1 - d_target / rejection_threshold, 0, 1)
```

The exact formula may be adjusted during calibration.

The PRD intentionally does **not** describe this number as statistical confidence because nearest-neighbor distance is not a calibrated probability.

### 7.6 Per-activity calibration

There is no universal success threshold for every task.

Each activity stores its own matching configuration:

```json
{
  "id": "custom_gesture_01",
  "check_type": "gesture",
  "success_threshold": 0.78,
  "review_threshold": 0.58,
  "config": {
    "calibration": {
      "target_distance_threshold": 0.41
    }
  }
}
```

Thresholds are derived from or tuned against the examples recorded for that task.

---

## 8. Rule-based task checks

Some tasks do not need a learned gesture matcher.

### Raise hand

The raise-hand check gives a **confidence from 0 to 1** per person, from their pose points:

```text
height     = (shoulder line y − higher wrist y) / shoulder width   # true proportions (16:9 corrected)
confidence = clamp(height / 1.0, 0, 1)      # shoulder level = 0, top of head ≈ 1
confidence = 0 if visibility of wrist or shoulders < 0.5          # visibility is a gate
```

Measuring in shoulder widths makes the score the same near and far from the camera. Visibility is a pass/fail gate rather than a multiplier: raised wrists often read 0.6–0.9 visibility, and multiplying pulled clearly raised hands below the threshold. The raised hand must also be an open palm facing the camera (otherwise the score is 0), so a raised fist or thumbs-up never completes raise-hand. Every known gesture is also detected continuously and shown in green on the station video when completed (display only; status and events follow the assigned task). The `raise_hand` activity uses success threshold 0.7 and review threshold 0.4; holding the score above the threshold for 1 s is the hold time.

---

## 9. Facial-expression context

### 9.1 Model

Use:

```text
hsemotion-onnx
model: enet_b0_8_best_vgaf
```

Run it locally on a face crop.

### 9.2 Preserve native model output

Do **not** drop classes and renormalize probabilities.

Keep the model’s native expression distribution internally, including:

- anger
- contempt
- disgust
- fear
- happiness
- neutral
- sadness
- surprise

The original probability associated with each class is preserved.

### 9.3 Temporal smoothing

Expression estimates are noisy frame-to-frame.

Maintain a short rolling window and average or otherwise smooth the probabilities before creating contextual signals.

Example:

```text
rolling window: 2 seconds
expression evaluation frequency: ~2–3 Hz
```

Exact values should be tuned on the demo laptop.

### 9.4 Expression as supporting evidence only

Cues never declares:

> “This student is struggling because they look sad.”

Instead:

1. task behavior establishes whether progress is difficult;
2. expression can add contextual evidence;
3. the combined state may increase urgency or priority.

Example:

```text
sustained stalled task progress
+
sustained sadness/anger/fear signal
=
higher-priority teacher cue
```

Expression by itself does **not** trigger a “student is struggling” conclusion.

### 9.5 Expression signal

A contextual expression signal may be created when a relevant native probability remains above a configured threshold for a persistence window.

Example configuration:

```json
{
  "labels": ["anger", "fear", "sadness"],
  "min_probability": 0.50,
  "min_duration_seconds": 5
}
```

These are configuration values, not clinical cutoffs.

The dashboard may display current expression context and probability for debugging/demo use, but this should be framed as **model output**, not as a verified emotional state.

---

## 10. Task progress logic

Each seat has a task-specific state machine.

Possible statuses:

```text
idle
in_progress
review
done
needs_help
tracking_lost
```

### 10.1 Success

Success is determined using the current activity’s own checker and calibration.

Examples:

- raise hand → boolean rule true for the configured persistence time;
- custom gesture → match score above that activity’s success threshold.

### 10.2 Review

Some activities may define a review band.

For example, a custom gesture may be close to the target but not high enough for automatic completion.

This creates:

```text
review_needed
```

The teacher can manually verify the task.

### 10.3 Failed attempt

A failed attempt should only be recorded when:

- the relevant body part is clearly detected;
- tracking is stable;
- the student appears to be making an attempt;
- the activity-specific matcher does not pass.

A short cooldown prevents many events from being emitted for one continuous attempt.

### 10.4 No progress

Each activity can define its own `no_progress_seconds`.

The demo configuration may use a shorter value than a real classroom deployment.

### 10.5 Tracking loss

If the required hand or face is missing for the configured duration:

```text
tracking_lost
```

Tracking-loss time pauses progress timers and is excluded from miss counts.

---

## 11. Deterministic progress and routing

The continuous worker polls Supabase seat_state approximately once per second.
ProgressEvaluator uses a rolling task-progress window and activity-specific
completion criteria. Its outputs are improving, stalled, completed and unknown.
Tracking invalidity, missing gesture scores and observation gaps clear the window;
tracking loss cannot accumulate student failure.

EscalationEvaluator requires stalled progress. Sustained qualifying expression
may support earlier evaluation or higher priority, never trigger it alone.
EvaluationRouter suppresses repeated eligible levels within a session/seat/task
episode. Improving or completion rearms an episode; unknown pauses suppression.
There is no timed cooldown or durable delivery guarantee.

ContextEnricher resolves task context before the Deep Agent runs. The legacy
activity no_progress_seconds field is not an agent eligibility gate.
ProgressHistoryStore records accepted evaluated summaries; it remains process-local.

---

## 12. AI support agent

The provider-independent Deep Agent receives an already eligible evaluation
request plus activity context and selects tools adaptively:

| Implemented tool | Purpose |
|---|---|
| get_recent_progress_history | Distinguish isolated stalls from repeated progress patterns |
| get_prompt_history | Retrieve explicitly recorded independence/prompting outcomes |
| request_teacher_review | Create a pending review using trusted application identity and priority. With `agent.interventions`, it may also carry one suggested support from the approved menu (below) |

History is scoped to session/seat/activity and bounded to ten entries per query.
Prompt history has no production observation producer yet; missing data remains
unknown. The agent never invents history or interprets empty results as evidence
for escalation.

Structured output contains continue_monitoring or teacher_review_warranted,
a concise rationale and constrained evidence_used labels. Defaults bound each run
to four model calls and three domain-tool attempts. Successful review creation
terminates from the stored assessment/review without another model turn.
Provider failures are surfaced and isolated; no automatic fallback review is fabricated.

### Research rationale and citations

**Design principles.** Prefer observable progress/task data over inferred emotional
state. Facial-expression output remains supporting context only. Do not introduce
`diagnose_behavior()` or `get_student_emotional_state()` tools, infer why a student
is struggling from a single observation, or store diagnoses as future behavioral
history. Any future contextual history should record observable events, including
antecedents and consequences only where actually observed. Teacher approval remains
required before instructional changes. Cues is not an FBA or diagnostic system.

**Research rationale.** Special-education progress-monitoring guidance favors
repeated progress trends, observable measures (latency, duration, frequency, or
interval data where appropriate), prompting outcomes and independence, and
educator-controlled intervention decisions. These sources inform the tool design;
they do not validate a Cues algorithm, prescribe its timeout values, or justify
inferring behavioral function from one camera observation.

#### Research citations for the information tools

- [IRIS Center — Systematic Direct Observation](https://iris.peabody.vanderbilt.edu/information-brief/systematic-direct-observation/): supports defining observable/measurable behavior and matching measurement methods, including latency, duration, frequency, and interval recording, to the observation goal.
- [National Center on Intensive Intervention — Progress Monitoring](https://intensiveintervention.org/data-based-individualization/progress-monitoring): supports repeated progress data and trend review, with educators/teams deciding whether to continue or adapt instruction/intervention.
- [NCII — Behavior Progress Monitoring Tools Chart](https://intensiveintervention.org/resource/behavior-progress-monitoring-tools-chart): supports selecting systematic monitoring tools suited to the target and assessing improvement/responsiveness over time; inclusion in the chart is not an endorsement of a particular tool or Cues.
- [AFIRM — Prompting Step-by-Step](https://afirm.fpg.unc.edu/sites/default/files/imce/resources/PP%20Step-by-Step.pdf): reference for tracking independence, prompted responses, errors, no-response, and prompt levels. The supplied PDF could not be retrieved during this update; the explicit outcome categories are also documented in [NPDC's prompting implementation guidance](https://autismpdc.fpg.unc.edu/sites/autismpdc.fpg.unc.edu/files/prompting-steps-LTM-impl.pdf).
- [IRIS Center — FBA / ABC Data Guidance](https://iris.peabody.vanderbilt.edu/module/fba-elem/cresource/q2/p06/): supports repeated, observable antecedent-behavior-consequence records to identify patterns; a single event is insufficient to infer behavioral function. This informs careful data representation, not automated diagnosis.


---

## 13. Teacher review and notification workflow

request_teacher_review() creates a pending Supabase-backed teacher review.
Trusted session/seat/activity/priority and original assessment remain immutable.
Only a new persisted review triggers the injected Photon/Spectrum notifier;
duplicate reuse and resolution do not notify. Notification failure retains the
review and surfaces a sanitized error without rolling back persistence.

The minimal message directs the teacher back to Cues, for example:
“Cues: Seat S1-P1 may need attention. Open Cues to review.”
No camera data, expression labels, diagnoses or detailed reasoning are sent.
Spectrum message acknowledgement has been verified in direct and hosted
pipeline smoke tests; acknowledgement does not establish device read receipt.

### Approved interventions

The agent picks only from this menu, and only suggests: repeat the instruction, show an example, model the task, break it into smaller steps, offer a short break, check in with the student. The suggestion rides on the review (`teacher_reviews.suggested_intervention`). The teacher approves it, or picks another item, with `approve_review_intervention`, which also confirms a pending review and records the approval in `interventions`. Cues changes no task or instruction by itself. Behind `agent.interventions` and `web.interventions` (default off); needs migration 018.

The teacher chooses Support needed (confirmed) or No support needed (dismissed).
resolve_teacher_review(review_id, action) permits pending → confirmed/dismissed
only, records server resolution time and rejects repeated resolution. Migration
20261115000100 also records a `seat_review_marks` acknowledgement in that same
transaction for the active session and matching activity. Vision and the worker
consume it to restart their timers. The dashboard suppresses the answered camera
flag while vision catches up; a newer observation or a different task/session
is not hidden by the old answer. Deploy this migration before the dashboard change.
This records human attention decisions, not approval of an automatic intervention.

With `web.flag_decisions` (default off), the teacher can also answer a camera flag
before an agent review exists. `record_teacher_flag_decision` saves the actual
confirmed/dismissed choice in `teacher_flag_decisions`, resolves any currently
pending review for that same task with the chosen answer, and acknowledges the
flag atomically. It never creates an agent review. The server verifies the session
owner, active activity/revision and a recent unacknowledged flag. The browser sends
an idempotency UUID and the observation it acted on; retrying the same request
returns its original record without restarting timers again. Flag off: offer the
single Mark as reviewed acknowledgement. Needs migration `20261115000200` after
`20261115000100`; neither repair has been deployed during this implementation.

## 14. Optional future voice controls

Voice/push-to-talk is outside the current demo startup path. Dashboard task
selection through sessions.current_activity_id is the core activity flow.
Any future voice control should map to known activities and describe hosted
transcription privacy accurately.

---

## 15. Teacher dashboard

Built with Next.js + Tailwind.

### 15.1 Seat/student card

*With person tracking (§6.2) there is one card per tracked person id (`S1-P1`, `S1-P2`, …), labelled "Person 1", "Person 2". Cards appear and disappear as people enter and leave; there is no fixed two-card layout. A per-person task override is lost if that person's id changes. These changes are Evan's to implement.*

Each card displays:

- pseudonym or station label ("Person N", by position);
- current task;
- status;
- latest task match score when applicable;
- elapsed time;
- latest event;
- contextual expression signal if enabled;
- active alert state.

### 15.2 Teacher review queue

The dashboard consumes persisted teacher_reviews through Supabase reads/Realtime.
Support needed and No support needed resolve pending reviews through the authenticated RPC.
Person-ID card/read-policy alignment remains a handoff gap. Teacher login/profile,
dynamic phone lookup and teacher/session ownership authorization remain incomplete;
current simulated-seat authorization is demo-only.

---

## 16. Station interface

The student-facing station page should stay intentionally simple.

It may display:

- current activity;
- short instruction;
- optional visual example;
- progress / waiting state;
- completion feedback;
- a software “I need help” control if desired.

The station interface should not show technical model scores to the student.

---

## 17. Data model

Session and alert IDs are UUIDs. Station, seat, and activity IDs are strings. An activity defines `id`; references to it use `activity_id`. Expression context uses `label` and `probability`. Preserve all 12 event types below and the session/timestamp fields in §17.3.

The shared Pydantic models in `shared/contracts.py` are authoritative for exchanged data; JSON examples are illustrative. Synthetic fixtures live in `shared/fixtures/`. The vision emitter validates and serializes these shared models. See `notes/archive/TEAM_WORKFLOW.md` for the agreed team boundaries.

### 17.1 Event

Vision service / backend → Supabase:

```json
{
  "session_id": "550e8400-e29b-41d4-a716-446655440000",
  "station_id": "S1",
  "seat_id": "S1-L",
  "type": "attempt_success",
  "activity_id": "custom_gesture_01",
  "score": 0.84,
  "payload": {
    "source": "auto"
  },
  "created_at": "2026-11-14T03:12:45Z"
}
```

Possible event types:

```text
attempt_success
attempt_miss
review_needed
no_progress
tracking_lost
expression_context
teacher_verified
agent_invoked
alert_created
teacher_approved
teacher_dismissed
intervention_applied
```

### 17.2 Expression event

Only meaningful contextual state needs to become an event.

Example:

```json
{
  "type": "expression_context",
  "seat_id": "S1-L",
  "payload": {
    "label": "sadness",
    "probability": 0.63,
    "duration_seconds": 6,
    "supporting_only": true
  }
}
```

The live expression distribution does not need to be stored as historical student data.

In a teacher-managed session, vision also adds `session_revision` (a non-negative integer) to every event payload, this one included, so the database can reject writes from an earlier revision. It is not part of the expression context.

### 17.3 Core tables

```sql
activities (
  id text primary key,
  name text,
  check_type text,
  keywords text[],
  success_threshold real,
  review_threshold real,
  no_progress_seconds integer,
  config jsonb
);

stations (
  id text primary key,
  name text
);

seats (
  id text primary key,
  station_id text,
  side text,
  display_name text,
  is_simulated boolean
);

sessions (
  id uuid primary key,
  started_at timestamptz,
  current_activity_id text,
  station_id text,          -- lifecycle migration 003: one active session per station
  ended_at timestamptz,     -- null while active
  revision integer         -- compare-and-set for teacher actions
);

seat_state (
  seat_id text primary key,
  session_id uuid,
  activity_id text,
  status text,
  tracking_valid boolean,
  task_score real,
  tracking_valid boolean,
  expression_context jsonb,
  updated_at timestamptz
);

events (
  id bigserial primary key,
  session_id uuid,
  station_id text,
  seat_id text,
  type text,
  activity_id text,
  score real,
  payload jsonb,
  created_at timestamptz default now()
);

alerts (
  id uuid primary key,
  seat_id text,
  reason text,
  priority text,
  suggestion text,
  evidence jsonb,
  status text,
  created_at timestamptz,
  resolved_at timestamptz
);

interventions (
  id uuid primary key,
  alert_id uuid,
  action text,
  approved_at timestamptz
);

support_preferences (
  seat_id text primary key,
  notes text,
  preferences jsonb
);

teacher_reviews (
  id uuid primary key,
  created_at timestamptz,
  session_id uuid,
  seat_id text,
  activity_id text,
  priority text,
  evaluation jsonb,
  decision text,
  rationale text,
  evidence_used jsonb,
  status text,
  resolved_at timestamptz
);

teacher_flag_decisions (
  id uuid primary key,
  session_id uuid,
  seat_id text,
  activity_id text,
  session_revision integer,
  observed_at timestamptz,
  decision text, -- confirmed / dismissed, distinct from the agent's assessment
  decided_at timestamptz,
  teacher_id uuid
);
```

`teacher_reviews` persists the existing typed `agent.teacher_review.TeacherReview`;
the full `AgentEvaluationRequest` is retained in `evaluation`, with matching
session/seat/activity/priority columns for consumers. Decision/rationale/evidence
come from the existing `AgentAssessment`. The exact constraints, immutable-field
guard and Realtime publication are in migration
`20261114000300_teacher_reviews.sql`. A review moves only from pending, to one of: confirmed (teacher's Support
needed), dismissed (No support needed), reviewed (the teacher's Mark as reviewed, migration 1500) or expired (closed by the system: session ended, task done or activity changed). This records an attention decision,
not intervention approval or an automatic instructional change. Server writes
are required; the existing simulated-seat RLS pattern permits demo-only reads.
The live runtime injects Supabase persistence; the in-memory store remains for offline use. Migration 004 provides authenticated resolution; demo scope permits authenticated users to resolve simulated-seat reviews, without teacher/session ownership authorization.

Migration `20261115000100_review_resolution_marks.sql` adds an acknowledgement
trigger to the existing confirmed/dismissed transition. It retains the review's
decision, evidence and response shape, and writes the server resolution timestamp
and authenticated actor to the existing `seat_review_marks` row. No camera score,
status or observation timestamp is changed. Answering a historical activity does
not acknowledge the current activity. The trigger also covers intervention
approval when that existing feature is enabled. This migration is local only;
hosted deployment and Keith/Michelle/Evan contract sign-off remain to be recorded
in the PR.

`shared.contracts.TeacherFlagDecision` is authoritative for the immutable camera-only
decision ledger. Migration `20261115000200_teacher_flag_decisions.sql` permits
owner-scoped reads and authenticated RPC writes only; direct client writes and
updates/deletes are rejected. Auth supplies `teacher_id`, the server supplies
`decided_at`, and the observation identifies the session/person/activity/revision.
The observed tuple is unique per session/person/revision/timestamp, as is the
request UUID. No perception payload or raw camera data is stored in this ledger.
Existing event types and existing review/mark response shapes are unchanged.
This shared-table addition still needs Keith, Evan and Michelle's sign-off in the PR.

---

### 17.4 Initial database setup

The initial schema is versioned in `supabase/migrations/20261114000100_initial_schema.sql`;
`supabase/seed.sql` supplies two simulated seats at station S1. The migration
implements the fields in §17.3 without introducing new event types or a status enum.
It intentionally permits events before session/seat rows are provisioned, matching
the current vision emitter. All tables enable Row Level Security. Public clients
have read-only access to simulated seats and their associated station, session,
activity and seat state; events, alerts, interventions and support preferences
remain server-only. Simulated demo state is publicly readable and must contain
no real student data or private notes. Only `seat_state` is initially enabled for
Postgres Changes. The read-only teacher seat overview is implemented in `web/`
behind `web.dashboard` (default off), with initial reads and realtime state
refreshes. The follow-up `20261114000200_align_demo_activity.sql` migration aligns
the synthetic activity's check type and timeout with the shared contract.
Migrations 003–017 are applied to the hosted project: persistent teacher reviews and resolution, nullable tracking_valid, sessions and activities, one default station per teacher, live progress on seat_state, review lifecycle and Mark as reviewed, the activity catalog with built-in gestures, timeline flags and the one-camera-per-station lease. seat_state and teacher_reviews are published through Realtime. The full list is in `notes/supabase.md`.

### 17.5 What vision writes and how it is used

See [vision-data.md](vision-data.md) for the current vision handoff.

Vision writes two kinds of data to Supabase, both validated against `shared/contracts.py`:

| Data | Table | When | Read by |
|---|---|---|---|
| `Event` | `events` (insert) | on each status change and expression episode | Michelle's rules engine |
| `SeatState` | `seat_state` (upsert on `seat_id`) | on each status change, otherwise once per second per person | Evan's dashboard cards; Michelle's progress evaluator |

Vision reads the station's active session, activity and revision once per second (the class-wide task the teacher picked), the review marks for that session (`seat_review_marks`, so a teacher's "Mark as reviewed" puts a child back to Working), and claims the station through `claim_station_writer` so only one camera writes to it. `seat_state` also carries `session_revision` (written by vision) and `evaluated_progress` (written only by the agent).

`seat_state` is the primary input to the progress pipeline (vision → `seat_state` → ProgressEvaluator → EscalationEvaluator → EvaluationRouter → ContextEnricher → Deep Agent). Each row carries `tracking_valid` (person seen in this frame; low score vs tracking failure) and an `expression_context` with `duration_seconds` (how long it has persisted). Events are informational for audit and debugging; vision makes no review or agent decision.

`seat_id` holds a person id (`S1-P1`…). tracking_valid is nullable with no default (migration 005). Invalid tracking persists false with null task_score; historical unknown values remain null. Person-ID read policies and the activity catalog are in place (migrations 010, 011, 014). Person ids are position-only and can change when someone leaves for over ten seconds or two people swap places.

## 18. Runtime boundaries

FastAPI serves local vision /health, /stream, /config (the signed-in teacher's station, loopback only), /gestures and gesture template recording/
retrieval/deletion endpoints. Fixed-seat controls and agent/alert endpoints are
not implemented. The agent runs through create_seat_state_runtime and the
agent.worker entrypoint. Teacher resolution uses Supabase RPC. See STARTUP.md.

---

## 19. Team responsibilities

The team has **3 people**.

Integration, product decisions, testing, presentation, and final polish are shared by the full team rather than assigned to a separate person.

### Keith — Vision / perception

Owns primarily:

```text
vision/
```

Responsibilities:

- webcam capture;
- person tracking;
- MediaPipe Hand Landmarker;
- face crop pipeline;
- HSEmotion ONNX inference;
- raise-hand rule;
- normalized landmark representation;
- nearest-neighbor gesture matching;
- gesture recorder;
- activity calibration;
- task-state event generation;
- tracking-loss handling;
- practitioner outreach and evidence for the Forward Deployed Challenge (maintained separately from this PRD).

### Evan — Frontend / app backend / realtime product

Owns primarily:

```text
web/
Supabase
```

Responsibilities:

- app backend and app-facing APIs;
- Supabase schema;
- realtime subscriptions;
- teacher dashboard;
- seat cards;
- alert panel;
- review queue;
- task controls;
- optional future voice controls;
- custom gesture recorder UI;
- station page;
- simulated seat support.

### Michelle — Agent / routing

Owns primarily:

```text
agent/
```

Responsibilities:

- event routing;
- episode suppression;
- rules engine;
- Deep Agents;
- provider-neutral LLM integration;
- agent tools;
- tool-choice logic;
- agent guardrails;
- alert creation;
- teacher approval workflow;
- Photon;
- isolated provider failure handling;

### Shared by all 3

- integration;
- event-contract decisions;
- product decisions;
- end-to-end testing;
- practitioner feedback incorporation;
- sponsor-track packaging;
- documentation;
- final UX polish;
- presentation and demo planning.

---

## 20. Integration and verification

Local perception, continuous structured-state consumption, deterministic routing,
adaptive information/action tools, persisted reviews, human resolution and
Photon acknowledgement have been implemented and exercised with offline and hosted
synthetic tests. Hardware accuracy and complete live dashboard/person-ID acceptance
remain separate checks. No automatic instructional intervention is implemented.

---

## 21. Dependencies and assumptions

- Logitech webcam is available.
- Demo laptop can run MediaPipe + HSEmotion concurrently at acceptable interactive speed.
- Internet is available for Supabase, Groq demo inference and Spectrum.
- A phone hotspot is available as a fallback.
- The selected provider must support event-driven agent calls within available rate limits.
- Photon sponsor access is available.
- Dashboard activity controls are the current task selection path.
- Only structured state reaches the agent.
- The system has no dependency on AWS Bedrock.
- Practitioner consultation and supporting evidence for the Forward Deployed Challenge are maintained separately from this technical PRD.

### Expected packages

Python:

```text
mediapipe
opencv-python
hsemotion-onnx
onnxruntime
fastapi
uvicorn
supabase
langchain
deepagents
```

Frontend:

```text
next
tailwindcss
@supabase/supabase-js
```

Exact package names should be confirmed during implementation.

---

## 22. Key technical risks

### R1 — Person tracking

**Risk:** ids swap when two children cross or overlap; partly visible children (cut off at the chest, behind someone) are missed or merged; a child who leaves and returns gets a new id.

**Mitigation:**

- pose in video mode, upper-body boxes, smoothing and a 0.5 s grace period;
- position-only ids, released after 10 s out of view;
- `tracking_lost` never counts as a failure;
- stable camera framing with heads and shoulders visible.

### R2 — Gesture-template overfitting

**Risk:** teacher examples work only under the exact recording pose/lighting.

**Mitigation:**

- normalize landmarks;
- record several examples;
- use rest/other examples;
- calibrate per activity;
- allow fast re-recording.

### R3 — HSEmotion generalization

**Risk:** expression predictions may not generalize well to children, SEN learners, pose changes, or real classroom conditions.

**Mitigation:**

- preserve native probabilities;
- temporal smoothing;
- expression is supporting evidence only;
- never diagnose;
- teacher remains the decision-maker;
- explicitly state that deployment would require validation.

### R4 — Agent latency

**Risk:** LLM response delays make alerts feel slow.

**Mitigation:**

- agent only receives compact structured state;
- no image/video input;
- select a provider/model with suitable latency and tool support;
- constrain actions to a fixed toolset;
- bounded provider timeout/retries and isolated failures.

### R5 — Agent unpredictability

**Risk:** inappropriate or unnecessary recommendation.

**Mitigation:**

- constrained teacher-review action;
- structured tools;
- teacher approval;
- no direct free-form instructional control;
- log all agent actions.

### R6 — Alert spam

**Risk:** repeated task misses create too many alerts.

**Mitigation:**

- event cooldowns;
- persistence windows;
- episode-level routing suppression;
- combine task failure and contextual signals into one agent run.

### R7 — Venue Wi-Fi

**Risk:** Supabase, the selected LLM provider, Photon, or speech transcription fails.

**Mitigation:**

- hotspot fallback;
- local perception continues independently;
- clear offline state;
- deterministic local behavior where possible.

### R8 — Voice recognition

**Risk:** noisy environment or browser speech dependency.

**Mitigation:**

- push-to-talk only;
- deterministic known-task mapping;
- large task buttons always available.

---

## 23. Product and ethical constraints

### 23.1 Teacher assistance, not replacement

Cues is an attention-routing and support tool.

It does not:

- grade students;
- diagnose students;
- determine emotional state with certainty;
- replace teacher observation;
- autonomously change learning goals.

### 23.2 Privacy

- no face recognition;
- no real student identities in the hackathon;
- no student video sent to the cloud;
- no images sent to Photon;
- local gesture templates stay on the station laptop;
- only structured events sync to Supabase;
- the LLM receives structured state only.

### 23.3 Facial-expression framing

Use terms such as:

- **facial-expression context**
- **expression signal**
- **model probability**

Avoid claims such as:

- “Cues knows the student is sad.”
- “Cues detects distress.”
- “Cues reads emotions.”

The model output is only one supporting cue.

### 23.4 Human approval

Teacher approval is required before Cues changes:

- a student task;
- an instruction;
- a support intervention.

A teacher notification itself does not require approval.

---

## 24. Success criteria for the MVP

The product is considered functionally successful when:

1. a Logitech camera streams into the local perception service;
2. MediaPipe reliably tracks the required hand landmarks;
3. a teacher can record a custom static gesture and use it immediately;
4. the gesture matcher produces an interpretable match score with task-specific calibration;
5. HSEmotion produces local native expression probabilities;
6. expression context can augment—but not replace—task-progress evidence;
7. meaningful student events appear in Supabase;
8. the teacher dashboard updates in realtime;
9. dashboard controls select a known activity;
10. the rules engine invokes the agent only for meaningful situations;
11. the Deep Agent chooses among real tools rather than returning only free-form chat;
12. the configured LLM provider supplies inference without receiving camera frames;
13. the agent can create a persisted pending teacher review;
14. Photon can notify the teacher of that alert;
15. the teacher can confirm attention or dismiss the review;
16. review status and resolution time persist without automatic instruction changes.

---

## 25. Stretch goals

Only attempt these after the complete core loop works.

- moving gesture recognition using DTW or sequence matching;
- multiple camera stations;
- richer individualized task sequences;
- end-of-session progress summaries from the event log;
- natural-language task creation beyond the fixed task list;
- local/on-device speech recognition;
- object-state tasks such as “open your book”;
- more advanced multi-person tracking;
- teacher analytics based on verified events.

---

## 26. Remaining implementation gaps

- Teacher login/profile workflow and dynamic teacher phone destination lookup.
- Teacher/session ownership authorization beyond simulated-seat demo scope.
- Person-ID dashboard visibility/read policies and vision/activity catalog alignment.
- Production prompt-history recording and durable longitudinal history.
- Hardware/demo acceptance, deployment supervision and delivery recovery.
- Intervention workflow: the approved menu, suggestion and approval are built behind flags and need migration 018 applied and a live check; applying an approved support to a student's task is not built. Voice remains optional future work.

---

## 27. Product principle

The central design principle of Cues is:

> **Use local perception to notice simple observable signals, use AI to reason about context and route attention, and keep the teacher in control of every meaningful instructional decision.**

## Rolling progress evaluation

The primary automatic routing trigger is sustained lack of progress, not a miss count. Keith supplies fresh task observations; Evan owns app state; Michelle evaluates the rolling window. `SeatState.tracking_valid` explicitly reports task tracking usability; unknown is not valid. For evaluator input, `updated_at` is the task observation time; expression-only/app updates must not masquerade as fresh task samples.

The implemented ProgressEvaluator compares earlier/later half-window means over a configurable four-second window, with one sample per half-second bucket. Improvement enters at 0.10 and exits below 0.05. It returns improving, stalled, completed, or unknown plus stalled_seconds; it does not route to an agent. Invalid tracking, missing gesture scores, and long observation gaps (more than 3 seconds: one missed 1 Hz vision heartbeat is tolerated, two are not) reset history. The worker polls at a fixed rate, so slow Supabase reads do not add to the gap. Completion uses the activity-specific gesture threshold or explicit done status. Same-task restarts require reset().

The separate pure evaluate_escalation function requires stalled progress before considering expression. Classroom thresholds are 5 seconds minimum observation, 6 expression-assisted, 10 normal stall, and 15 prolonged stall. Demo thresholds are 2/5/4/6 seconds, passed through a configuration object. These are engineering defaults, not clinical or universal learner thresholds. Demo timings are intentionally compressed and are not classroom recommendations. The progress window is configured separately; demo callers explicitly select the two-second progress window; expression persistence remains five seconds.

Only qualifying sustained expression context can accelerate or elevate an already stalled situation. Improving, completed, and unknown never escalate. Eligibility does not create an alert or imply student failure. LLM evaluation and notifications are implemented downstream; timed cooldowns are not. See notes/michelle.md for API, source citations, qualifications, and verification results.
