-- Task observability: could Cues judge this person on the task right now?
-- Different from tracking_valid (the person is still tracked). false = missing evidence, with
-- task_score null; true = a judged observation, where task_score 0 is a real failure.
-- Nullable and unset on old rows: readers then follow task_score, so nothing breaks before or
-- after this is applied. Apply it before relying on the column; vision and the agent fall back
-- without it.
alter table public.seat_state add column if not exists task_observable boolean;
