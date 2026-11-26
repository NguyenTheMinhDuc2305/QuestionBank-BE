from types import SimpleNamespace
from uuid import uuid4

import pytest

from app.schemas import DraftBatch
from app.worker import process


def element(text, image=False, audio=True):
    return {
        "text": text,
        "audio": {"transcript": text, "description": "Read clearly"} if audio else None,
        "image": {"prompt": text, "negative_prompt": "text"} if image else None,
    }


CASES = [
    (
        {
            "question_type": "COMP_SEL",
            "stem": element("This is a ___.", image=True, audio=False),
            "options": [
                {**element(x), "is_correct": x == "pen"} for x in ["pen", "book", "cat", "dog"]
            ],
        },
        "completion_options",
        4,
    ),
    (
        {
            "question_type": "TYPING",
            "stem": element("This is a ___.", image=True, audio=False),
            "answer": element("pen"),
            "completed_sentence": "This is a pen.",
        },
        "typing_questions",
        1,
    ),
    (
        {
            "question_type": "MATCH",
            "pairs": [
                {"left": element(x), "right": element(x, image=True)} for x in ["pen", "book"]
            ],
        },
        "matching_pairs",
        2,
    ),
    (
        {
            "question_type": "ORDER",
            "tokens": [element("This"), element("is"), element("a pen.")],
            "answer": element("This is a pen."),
        },
        "ordering_tokens",
        3,
    ),
    (
        {
            "question_type": "LISTEN",
            "items": [element("black cat", image=True), element("white dog", image=True)],
        },
        "listening_items",
        2,
    ),
]


class DB:
    def __init__(self):
        self.s = SimpleNamespace(
            supabase_images_bucket="images",
            supabase_audios_bucket="audios",
            openrouter_audio_model="test",
            openrouter_audio_voice="test",
            openrouter_audio_api="chat",
            openrouter_speech_instructions=False,
        )
        self.tables = {"learning_objectives": [{"content": "test"}]}
        self.saved = []
        self.uploads = []

    async def select(self, table, **params):
        rows = self.tables.get(table, [])
        return [r for r in rows if "id" not in params or r["id"] == params["id"][3:]]

    async def patch(self, *args, **kwargs):
        return [{"id": "job"}]

    async def insert(self, table, row):
        self.tables.setdefault(table, []).append(row)

    async def upload(self, bucket, key, blob, mime):
        self.uploads.append((bucket, key))

    async def rpc(self, name, body):
        assert name == "save_generated_question"
        self.saved.append(body)
        self.tables.setdefault("questions", []).append(body["p_question"])


class Provider:
    def __init__(self, q):
        self.q = q
        self.calls = 0

    async def content(self, req, lo):
        return DraftBatch.model_validate({"questions": [self.q]})

    async def image(self, spec, key, checkpoint):
        self.calls += 1
        await checkpoint("provider-job")
        return b"image", "image/png", "provider-job"

    async def audio(self, spec):
        self.calls += 1
        return b"audio", "audio/wav"


@pytest.mark.parametrize("draft,child,count", CASES)
async def test_each_type_normalizes_and_links_individual_audio(draft, child, count):
    db = DB()
    provider = Provider(draft)
    job = {
        "id": str(uuid4()),
        "request_key": str(uuid4()),
        "config": {
            "lo_id": str(uuid4()),
            "question_type": draft["question_type"],
            "bloom_level": 1,
            "include_audio": True,
            "include_images": draft["question_type"] != "ORDER",
        },
    }
    db.tables["learning_objectives"][0]["id"] = job["config"]["lo_id"]
    await process(db, provider, job, str(uuid4()))
    assert len(db.saved) == 1
    records = [r["row"] for r in db.saved[0]["p_records"] if r["table"] == child]
    assert len(records) == count
    for row in records:
        keys = [k for k in row if k.endswith("audio_id")]
        assert keys
        for key in keys:
            # Optional stem audio may be absent; answer/item audio must be present.
            if child == "typing_questions" and key == "audio_id":
                continue
            assert row[key] in {r["id"] for r in db.tables["audios"]}
    if child in ("completion_options", "listening_items", "ordering_tokens"):
        assert len({r["audio_id"] for r in records}) == count
