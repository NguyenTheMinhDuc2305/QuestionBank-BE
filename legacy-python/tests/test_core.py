import base64
import json
from uuid import uuid4

import httpx
import pytest
from pydantic import ValidationError

from app.config import Settings
from app.providers import ProviderError, Providers, effective_image_prompt, pcm16_to_wav
from app.schemas import (
    AudioSpec,
    Completion,
    DraftBatch,
    GenerationRequest,
    ImageSpec,
    Listening,
    Ordering,
    Typing,
    validate_batch,
)


def settings(**kwargs):
    return Settings(
        _env_file=None,
        supabase_url="https://test.supabase.co",
        supabase_secret_key="sb_secret_dummy",
        **kwargs,
    )


def completion():
    return {
        "question_type": "COMP_SEL",
        "stem": {"text": "I write with a ___."},
        "options": [
            {"text": word, "is_correct": word == "pen"} for word in ("pen", "bag", "cat", "bus")
        ],
    }


def test_negative_prompt_appended():
    assert (
        effective_image_prompt(ImageSpec(prompt="a cat", negative_prompt="text"))
        == "a cat\n\nAvoid: text"
    )


def test_reject_dashboard_url():
    with pytest.raises(ValidationError):
        Settings(
            _env_file=None,
            supabase_url="https://supabase.com/dashboard/project/test",
            supabase_secret_key="dummy",
        )


def test_no_defaults_for_paid_models():
    missing = settings().generation_errors(images=True, audio=True)
    assert "OPENROUTER_TEXT_MODEL" in missing
    assert "OPENROUTER_AUDIO_MODEL" in missing


def test_completion_exactly_one_correct():
    raw = completion()
    raw["options"][1]["is_correct"] = True
    with pytest.raises(ValidationError):
        Completion.model_validate(raw)


def test_typing_answer_consistency():
    with pytest.raises(ValidationError):
        Typing.model_validate(
            {
                "question_type": "TYPING",
                "stem": {"text": "A ___."},
                "answer": {"text": "pen"},
                "completed_sentence": "A cat.",
            }
        )


def test_listen_requires_individual_audio():
    with pytest.raises(ValidationError):
        Listening.model_validate(
            {"question_type": "LISTEN", "items": [{"text": "cat"}, {"text": "dog"}]}
        )


def test_ordering_word_limit_not_just_chunks():
    with pytest.raises(ValidationError):
        Ordering.model_validate(
            {
                "question_type": "ORDER",
                "tokens": [
                    {"text": "one two three four five six"},
                    {"text": "seven eight nine ten eleven"},
                ],
                "answer": {"text": "one two three four five six seven eight nine ten eleven"},
            }
        )


def test_audio_required_on_every_option():
    batch = DraftBatch(questions=[Completion.model_validate(completion())])
    req = GenerationRequest(
        request_key=uuid4(),
        lo_id=uuid4(),
        question_type="COMP_SEL",
        bloom_level=1,
        include_audio=True,
    )
    with pytest.raises(ValueError, match="separate audio"):
        validate_batch(batch, req)


def test_no_unrequested_media():
    raw = completion()
    raw["stem"]["image"] = {"prompt": "pen"}
    req = GenerationRequest(
        request_key=uuid4(), lo_id=uuid4(), question_type="COMP_SEL", bloom_level=1
    )
    with pytest.raises(ValueError, match="Unrequested image"):
        validate_batch(DraftBatch.model_validate({"questions": [raw]}), req)


async def test_stream_audio_pcm16_chunks_wrapped_as_wav():
    pcm_parts = [b"\x01\x00\x02\x00", b"\x03\x00"]
    # Each SSE chunk is independently base64-encoded (with its own padding).
    chunks = [base64.b64encode(p).decode() for p in pcm_parts]

    async def handler(request):
        assert request.headers["Authorization"] == "Bearer test"
        body = json.loads(request.content)
        assert body["stream"] is True
        assert body["audio"]["format"] == "pcm16"
        events = [
            "data: " + json.dumps({"choices": [{"delta": {"audio": {"data": c}}}]}) for c in chunks
        ]
        return httpx.Response(200, text="\n\n".join(events + ["data: [DONE]"]) + "\n\n")

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        provider = Providers(settings(openrouter_api_key="test"), client)
        data, mime = await provider.audio(AudioSpec(transcript="hello"))
    assert mime == "audio/wav"
    assert data == pcm16_to_wav(b"".join(pcm_parts), 24000)
    assert data[:4] == b"RIFF" and data[8:12] == b"WAVE" and data[44:] == b"".join(pcm_parts)
    assert int.from_bytes(data[24:28], "little") == 24000


async def test_stream_audio_rejects_incomplete_stream():
    async def handler(request):
        event = {"choices": [{"delta": {"audio": {"data": base64.b64encode(b"ab").decode()}}}]}
        return httpx.Response(200, text="data: " + json.dumps(event) + "\n\n")

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        provider = Providers(settings(openrouter_api_key="test"), client)
        with pytest.raises(ProviderError, match="Incomplete"):
            await provider.audio(AudioSpec(transcript="hello"))


async def test_image_uses_job_and_same_origin_download():
    seen = []

    async def handler(request):
        seen.append(request.url.path)
        if request.method == "POST":
            body = json.loads(request.content)
            assert set(body) == {"prompt", "idempotency_key"}
            assert "Avoid: text" in body["prompt"]
            return httpx.Response(202, json={"job_id": "job1"})
        if "/jobs/" in request.url.path:
            return httpx.Response(
                200,
                json={
                    "status": "succeeded",
                    "image_url": "/v1/images/a.png",
                    "params": {"model": "qwen-image"},
                },
            )
        return httpx.Response(200, content=b"\x89PNG\r\n\x1a\nfake")

    recorded = []

    async def checkpoint(job_id):
        recorded.append(job_id)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        data, mime, job, model = await Providers(settings(), client).image(
            ImageSpec(prompt="cat", negative_prompt="text"), "key", checkpoint
        )
    assert recorded == ["job1"] and mime == "image/png"
    assert model == "tguru:qwen-image"
    assert len(seen) == 3


async def test_image_rejects_external_url_without_leaking_key():
    async def handler(request):
        assert request.url.host == "genimg.tguru.vn"
        if request.method == "POST":
            return httpx.Response(202, json={"job_id": "job1"})
        return httpx.Response(
            200, json={"status": "succeeded", "image_url": "https://evil.test/image"}
        )

    async def checkpoint(_):
        pass

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(ProviderError, match="outside"):
            await Providers(settings(), client).image(ImageSpec(prompt="cat"), "key", checkpoint)
