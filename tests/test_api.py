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
            admin_emails=["admin@test.com"],
        )

    async def user(self, token):
        if token == "valid":
            return {"id": str(uuid4()), "email": "admin@test.com", "email_confirmed_at": "now"}
        if token == "outsider":
            return {"id": str(uuid4()), "email": "other@test.com", "email_confirmed_at": "now"}
        return None


def test_auth_and_configuration_guard():
    with TestClient(app) as client:
        app.state.db = FakeDB()
        assert client.get("/health").status_code == 200
        assert client.get("/v1/jobs").status_code == 401
        assert client.get("/v1/jobs", headers={"Authorization": "Bearer bad"}).status_code == 401
        assert (
            client.get("/v1/jobs", headers={"Authorization": "Bearer outsider"}).status_code == 403
        )
        response = client.post(
            "/v1/jobs",
            headers={"Authorization": "Bearer valid"},
            json={
                "request_key": str(uuid4()),
                "lo_id": str(uuid4()),
                "question_type": "COMP_SEL",
                "bloom_level": 1,
            },
        )
        assert response.status_code == 503
        assert "OPENROUTER_TEXT_MODEL" in response.json()["detail"]["missing_settings"]
