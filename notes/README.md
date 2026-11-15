# Cues documentation

Everything except `README.md`, `STARTUP.md` and the tool-bound files (`CLAUDE.md`, `AGENTS.md`, `.github/pull_request_template.md`, `.claude/`) lives here. When behaviour, a command, a flag or a table changes, update the doc that describes it in the same PR (see CLAUDE.md, "Where the docs live").

## Start here

| Doc | What it is |
|---|---|
| [PRD-cues.md](PRD-cues.md) | Product requirements. §17 is the shared data contract. |
| [outstanding-work.md](outstanding-work.md) | What is still open, ranked P0 to P3. |
| [pipeline-audit.md](pipeline-audit.md) | Every connection from camera to teacher, and its limits. |
| [archive/TEAM_WORKFLOW.md](archive/TEAM_WORKFLOW.md) | Branches, ownership, merging. |

## Product and design

[PRODUCT.md](PRODUCT.md), [DESIGN.md](DESIGN.md), [teacher-workspace-alignment-spec.md](teacher-workspace-alignment-spec.md)

## Vision (Keith)

[keith.md](keith.md) (handoff and commands), [vision-data.md](vision-data.md) (what vision writes, endpoints, gestures API), [session-lifecycle.md](session-lifecycle.md) (how vision follows teacher sessions)

## Database and shared contracts

[supabase.md](supabase.md) (all migrations and their status), [shared-contracts.md](shared-contracts.md) (Python contracts and fixtures)

## Dashboard (Evan)

[evan.md](evan.md), [web.md](web.md) (overview and generated flag table), [web-ui-redesign.md](web-ui-redesign.md), [web-session-controls.md](web-session-controls.md), [web-teacher-reviews.md](web-teacher-reviews.md), [web-person-observations.md](web-person-observations.md), [web-progress-context.md](web-progress-context.md)

## Agent and notifications (Michelle)

[michelle.md](michelle.md), [photon-sender.md](photon-sender.md) (the `cues/` Spectrum sender)
