# Agent execution and information audit — 2026-11-15

Question: is the Cues support agent actually working, and is useful information
being replaced by hardcoded behavior? This is a read-only code/runtime audit and
a synthetic provider check. No Supabase reads/writes, migrations, notifications,
camera capture, branch synchronization or process restarts were performed.

## What is real and what is deterministic

The application contains one actual tool-calling Deep Agent, not several LLM
agents. `agent/deep_agent.py` explicitly disables general-purpose subagents and
offers three domain tools: `get_recent_progress_history`, `get_prompt_history`
and `request_teacher_review`. The provider is injected; `agent/worker.py` selects
Groq `openai/gpt-oss-20b` for the running application.

The current architecture is:

```text
Structured observation → deterministic progress/escalation/router
→ model selects information tools and decides whether to request review
→ stored review → dashboard / minimal teacher notification
```

The model supplies the review rationale and evidence labels. The application
validates those outputs and supplies trusted session/person/activity/priority.
Those identity and eligibility checks are not fake model reasoning. Fixed task
thresholds, tracking-loss handling, expression-only rejection, approval boundaries,
model budgets and notification privacy remain appropriate deterministic rules.

## Execution evidence and limits

- Local process inspection found Python worker PID **66372** in
  `.claude/worktrees/hallucination-issue-9e4260`, profile `dev`.
- That worktree was clean at `5f90b14` (`claude/hallucination-issue-9e4260`). The
  previous runtime-alignment snapshot is no longer current for the worker.
- File comparisons found no difference between that worktree and this checkout
  for `agent/worker.py`, `agent/deep_agent.py`, `agent/runtime.py`,
  `agent/seat_state_runtime.py` or `web/lib/teacher-reviews.ts`. This comparison does
  not establish that their environment settings or all frontend files match.
- **121 targeted local tests passed** across agent graph/tools, context enrichment,
  runtime composition/polling and both history stores. These exercise scripted test
  models and cannot establish live provider availability.
- A real Groq check used only synthetic data and explicit `--offline-reviews`:
  `current_context_sufficient`, `review_action`, `prompt_support_pattern`.
  All three returned **RateLimitError**, no model decision, no domain-tool result
  and no created review. The script returned failure. No further provider retries
  were initiated after this result.
- This proves that this checkout's live test was rate-limited. A running process
  is not proof of successful inference; the test does not independently establish
  the other worktree's loaded credentials or latest live assessment outcome.

Command used:

```bash
UV_CACHE_DIR=/tmp/cues-audit-uv-cache uv run python -m agent.live_groq_smoke --offline-reviews --scenario current_context_sufficient --scenario review_action --scenario prompt_support_pattern
```

## Information gaps

| Boundary | Current behavior | Effect |
|---|---|---|
| Input context | `EnrichedEvaluationContext` contains only the eligible request and matching Activity | The model receives task metadata, progress/stall and escalation summaries, rather than the full structured observation or support preferences |
| Recent history | At most 50 process-local progress summaries per identity; a tool call returns at most ten | History is short and disappears when the worker restarts |
| Prompt history | A real retrieval tool exists, but no production producer supplies prompting outcomes | The tool cannot truthfully report actual prompting history in the normal worker |
| Support preferences | No support-preference retrieval tool is registered | The database's existing preference data is not available through this agent's tool set |
| Agent result | `AgentAssessment` permits decision, rationale (up to 500 characters), evidence labels and an optional menu suggestion | It has no dedicated observed-facts, uncertainty or agent-execution-status fields |
| Monitoring/failure delivery | `SeatStateRuntime.run_forever` discards returned per-row results; monitoring is logged and provider failures are isolated/logged | The UI cannot distinguish monitoring from a model failure or an evaluation that is still pending through this result path |
| Review delivery | Only a successful `request_teacher_review` action creates a persisted review | A structured assessment saying review is warranted does not itself create a review; this is explicit model-controlled action behavior |
| Primary UI | `reviewPrompt` is fixed text; the actual model rationale sits in collapsed details in ReviewCard and PersonDetails | Teachers initially see almost the same message for different model assessments |
| Rationale formatting | `teacherRationale` replaces any unknown snake_case token with `additional review context` | Valid task identifiers/tool terminology in a rationale can lose useful meaning during presentation |
| Open reviews | The persistence store reuses an existing pending review without refreshing its evidence | Later assessments do not enrich the reason already on screen |
| Suggestions | `agent.interventions` and `web.interventions` default off | The optional model-chosen support menu is normally unavailable |
| Notifications | The message template is intentionally minimal and fixed | Rich explanation belongs on the authenticated dashboard; expanding SMS/iMessage with student context would violate the current product boundary |

Sources: `agent/deep_agent.py` (prompt, tools and disabled subagents),
`agent/assessment.py`, `agent/context_enricher.py`, `agent/router.py`,
`agent/progress_history.py`, `agent/prompt_history.py`,
`agent/seat_state_runtime.py` (process_row/run_once/run_forever),
`agent/supabase_teacher_review.py` (open review reuse), `agent/notifications.py`,
`web/lib/teacher-reviews.ts`, `web/components/review-card.tsx` and
`web/components/person-panel.tsx`.

## Proposed next implementation, not performed by this audit

1. Expose the existing agent rationale and evidence clearly in the teacher's review
   card, keeping a camera-only flag visibly distinct from an agent assessment.
   Do not replace a missing/failed assessment with generated-looking fixed text.
2. Define and relay agent execution status and latest monitoring/failure result.
   First specify its local-only prototype and eventual persistence contract; the
   current restriction prohibits hosted schema/data changes.
3. Expand the agent's structured context/tools with real available observations,
   support preferences and observed teacher-response history. Wire producers before
   claiming history exists. Preserve teacher approval and local camera privacy.
4. Verify a provider-backed run once quota permits, including tool choices and the
   actual dashboard result. Keep offline graph tests and live provider checks
   separate in the verification record.

No agent/UI behavior was changed in this audit. The previous repair migrations
remain local and `web.flag_decisions` remains off. Do not replace the established
Deep Agents architecture or add extra LLM agents merely to make the flow look
more agentic.

## Follow-up: Groq versus Photon availability

The user asked whether rate limits still apply and whether this prevents Photon
messaging. Two bounded checks used the configured Groq model and no retries:

- Tiny synthetic request, `max_tokens=16`: succeeded in 0.61 seconds.
- Normal agent graph with the existing synthetic `review_action` scenario and
  in-memory-only reviews: `RateLimitError` in 0.30 seconds, no decision/tool result
  or created review. A successful tiny request does not establish sufficient quota
  for normal agent context. The exact token/request quota cause was not established.

Photon/Spectrum is a separate provider. `cues/src/send.ts` and the dashboard's
notification test path do not call Groq. The automatic review-notification path
does require a newly persisted pending review: if the model fails before creating
one, the notifier is never reached. This is an upstream trigger failure, not
evidence that Photon itself is unavailable. Recipient activation, consent and
provider delivery still need independent verification. No Photon message was
sent and no Supabase state was changed during these checks.

## Solution investigation and subsequent successful request

A later synthetic request through `CuesDeepAgent.run`, still using explicit
in-memory review storage, the same Groq model and zero provider retries,
**succeeded** with `continue_monitoring`. No output cap was configured for that
request. Thus a normal agent request is not universally blocked now; the precise
quota/window responsible for earlier failures remains unverified. This does not
establish that the running worker's recent requests or notification flow succeeded.

Groq's primary documentation describes request/token limits at organization level,
429 responses, `retry-after`, remaining/reset headers and higher plan limits:
https://console.groq.com/docs/rate-limits . Account-specific limits should be
checked there rather than assumed from public model tables.

Code recovery gap: `EvaluationRouter.route` records an eligible level before
`SeatStatePipeline.process_row` invokes the model. If that invocation fails,
`SeatStateRuntime.run_once` logs the exception without rearming the router or
queuing a retry. Equal/weaker levels remain suppressed; only a stronger level,
recovery/completion or explicit reset can rearm evaluation. At the strongest
failed level, a continuing stalled episode may receive no further model attempt
even after quota becomes available. This is separate from Groq enforcing limits.

Proposed first code fix: bounded, rate-aware retry/cooldown for failed eligible
evaluations, honoring provider retry timing and requiring fresh, still-applicable
session/task/tracking evidence before retry. Do not reset routing and immediately
retry on every observation, create a synthetic review, or send invented agent
reasoning. Budget model input/output and make provider unavailability visible.
Higher organization quota or another configured provider addresses capacity when
real workload exceeds the available limit; code cannot manufacture that capacity.
No retry implementation, provider switch, account change or Supabase write was
performed during this investigation.
