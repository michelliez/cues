from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from agent import worker
from agent.escalation import DEMO_ESCALATION_CONFIG


@pytest.mark.parametrize("profile", ["dev", "demo"])
def test_worker_passes_explicit_profile_and_polling(monkeypatch, profile):
    monkeypatch.setattr("sys.argv", ["worker", "--profile", profile])
    monkeypatch.setattr(worker, "load_dotenv", lambda *args: None)
    # This test is about profile timing, not live progress; a developer's root .env may turn
    # that flag on (vision.supabase_client loads it on import), which adds an option.
    monkeypatch.setenv("CUES_FLAG_AGENT_LIVE_PROGRESS", "0")
    monkeypatch.setattr(
        "dotenv.dotenv_values",
        lambda *args: {
            "SPECTRUM_PROJECT_ID": "offline",
            "SPECTRUM_PROJECT_SECRET": "offline",
        },
    )
    for name in ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "GROQ_API_KEY", "CUES_SESSION_ID"):
        monkeypatch.setenv(name, "offline")
    monkeypatch.setattr(worker, "load_activities", lambda: {})
    monkeypatch.setattr(worker, "ChatGroq", lambda **kwargs: object())
    runtime = SimpleNamespace(run_forever=Mock())
    create = Mock(return_value=runtime)
    monkeypatch.setattr(worker, "create_seat_state_runtime", create)
    worker.main()
    if profile == "demo":
        assert create.call_args.kwargs == {
            "progress_window_seconds": 2,
            "escalation_config": DEMO_ESCALATION_CONFIG,
            "poll_seconds": 0.5,
        }
    else:
        assert create.call_args.kwargs == {}  # Retain classroom runtime defaults.
    runtime.run_forever.assert_called_once()
