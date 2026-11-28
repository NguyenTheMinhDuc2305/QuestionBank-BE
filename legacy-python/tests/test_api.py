import os
from uuid import uuid4

os.environ.setdefault("SUPABASE_URL", "https://test.supabase.co")
os.environ.setdefault("SUPABASE_SECRET_KEY", "sb_secret_dummy")

from fastapi.testclient import TestClient

from app.config import Settings
from app.main import app


class FakeDB:
    def __init__(self):
        self.s = Settings(
            _env_file=None,
            supabase_url="https://test.supabase.co",
            supabase_secret_key="sb_secret_dummy",
        )


def test_no_login_and_configuration_guard():
    with TestClient(app) as client:
        app.state.db = FakeDB()
        assert client.get("/health").status_code == 200
        assert client.get("/v1/config").status_code == 200
        response = client.post(
            "/v1/jobs",
            json={
                "request_key": str(uuid4()),
                "lo_id": str(uuid4()),
                "question_type": "COMP_SEL",
                "bloom_level": 1,
            },
        )
        assert response.status_code == 503
        assert "OPENROUTER_TEXT_MODEL" in response.json()["detail"]["missing_settings"]


class ListDB(FakeDB):
    def __init__(self):
        super().__init__()
        self.params = None

    async def select(self, table, **params):
        assert table == "questions"
        self.params = params
        row = {
            "id": str(uuid4()),
            "question_type": "MATCH",
            "bloom_level": 2,
            "status": "draft",
            "instruction_text": "Match",
            "created_at": "2026-01-01T00:00:00Z",
            "job_id": str(uuid4()),
            "item_index": 0,
            "question_los": [{"lo_id": "x", "learning_objectives": {"code": "LO1", "grade": 1}}],
            "completion_questions": None,
            "typing_questions": None,
            "ordering_questions": None,
            "matching_questions": {
                "matching_pairs": [
                    {"left_text": "dog", "right_text": "chó", "position": 1},
                    {"left_text": "cat", "right_text": "mèo", "position": 0},
                ]
            },
            "listening_questions": None,
        }
        return [row, {**row, "id": str(uuid4())}]


def test_list_generated_questions_filters_and_paging():
    with TestClient(app) as client:
        db = ListDB()
        app.state.db = db
        r = client.get("/v1/questions?grade=1&status=draft&question_type=MATCH&limit=1")
        assert r.status_code == 200
        body = r.json()
        assert body["has_more"] is True and len(body["items"]) == 1
        item = body["items"][0]
        assert item["summary"] == "cat ↔ mèo · dog ↔ chó"
        assert item["lo"]["code"] == "LO1"
        assert db.params["question_los.learning_objectives.grade"] == "eq.1"
        assert db.params["status"] == "eq.draft"
        assert db.params["limit"] == 2
        assert client.get("/v1/questions?status=bogus").status_code == 422
