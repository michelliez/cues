"""The activities a teacher can pick (database) must match what vision can detect."""

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def test_every_builtin_gesture_is_seeded_with_vision_values():
    catalog = json.loads((ROOT / "vision/activities.json").read_text())
    builtins = [a for a in catalog if a.get("builtin")]
    assert builtins, "expected built-in gestures in the vision catalog"
    sql = (ROOT / "supabase/migrations/20261114001400_builtin_gestures.sql").read_text()
    seed = (ROOT / "supabase/seed.sql").read_text()
    for activity in builtins:
        pattern = (
            rf"\('{activity['id']}', '{re.escape(activity['name'])}', '{activity['check_type']}', "
            rf"array\[(.*?)\], ([0-9.]+), ([0-9.]+), (\d+),"
        )
        row = re.search(pattern, sql)
        assert row, f"{activity['id']} is missing from the built-in gestures migration"
        assert [k.strip("' ") for k in row.group(1).split(",")] == activity["keywords"]
        # The seed runs after the migrations. Where it upserts a built-in (open_palm, whose
        # success threshold was calibrated after migration 014), its values are the ones a
        # fresh database ends with; otherwise the migration's are.
        upserted = re.search(pattern + r".*?on conflict \(id\) do update", seed, re.S)
        final = upserted or row
        assert float(final.group(2)) == activity["success_threshold"]
        assert float(final.group(3)) == activity["review_threshold"]
        # no_progress_seconds is not compared: nothing reads it from the database. Vision's
        # catalog (activities.json) owns the timer, and the agent loads vision's values.
        assert f"('{activity['id']}'," in seed  # fresh databases get it too
