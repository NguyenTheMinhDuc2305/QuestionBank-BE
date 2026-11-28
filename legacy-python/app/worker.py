"""Separate long-running process: python -m app.worker. Never run inside Vercel."""

import asyncio
import hashlib
import json
import logging
from contextlib import suppress
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4, uuid5

import httpx

from app.config import get_settings
from app.db import Database
from app.providers import Providers, effective_image_prompt
from app.schemas import (
    Completion,
    DraftBatch,
    GenerationRequest,
    Listening,
    Matching,
    Ordering,
    Typing,
    elements,
)

log = logging.getLogger("worker")


async def process(db: Database, providers: Providers, job: dict, worker: str):
    req = GenerationRequest.model_validate({**job["config"], "request_key": job["request_key"]})
    lo = (await db.select("learning_objectives", id=f"eq.{req.lo_id}"))[0]
    state = job.get("checkpoint") or {"media": {}}
    state.setdefault("media", {})

    async def checkpoint():
        rows = await db.patch(
            "generation_jobs",
            {"checkpoint": state},
            id=f"eq.{job['id']}",
            worker_id=f"eq.{worker}",
            status="eq.running",
        )
        if not rows:
            raise RuntimeError("Worker lost job ownership")

    if "draft" not in state:
        draft = await providers.content(req, lo)
        state["draft"] = draft.model_dump(mode="json")
        await checkpoint()
    batch = DraftBatch.model_validate(state["draft"])
    # Exact request reuse within this batch. Distinct answer transcripts remain separate files.
    cache = {}

    async def media(spec, kind):
        if spec is None:
            return None
        signature = kind + ":" + json.dumps(spec.model_dump(), sort_keys=True)
        if signature in cache:
            return cache[signature]
        media_id = str(uuid5(UUID(job["id"]), signature))
        table = "images" if kind == "image" else "audios"
        existing = await db.select(table, id=f"eq.{media_id}")
        if existing:
            cache[signature] = media_id
            return media_id
        state["media"].setdefault(media_id, {"kind": kind, "status": "generating"})
        await checkpoint()
        if kind == "image":

            async def provider_checkpoint(provider_id):
                state["media"][media_id]["provider_job_id"] = provider_id
                await checkpoint()

            blob, mime, provider_id, model_name = await providers.image(
                spec, media_id, provider_checkpoint
            )
            bucket = db.s.supabase_images_bucket
            row = {
                "prompt": spec.prompt,
                "negative_prompt": spec.negative_prompt,
                "effective_prompt": effective_image_prompt(spec),
                "model_name": model_name,
                "provider_job_id": provider_id,
                "generation_params": {"provider": "tguru", "base_url": db.s.img_gen_base_url},
            }
        else:
            blob, mime = await providers.audio(spec)
            bucket = db.s.supabase_audios_bucket
            row = {
                "transcript": spec.transcript,
                "description": spec.description,
                "model_name": db.s.openrouter_audio_model,
                "voice": db.s.openrouter_audio_voice,
                "generation_params": {
                    "api": db.s.openrouter_audio_api,
                    "format": "pcm16->wav" if db.s.openrouter_audio_api == "chat" else "mp3",
                    "description_sent": db.s.openrouter_audio_api == "chat"
                    or db.s.openrouter_speech_instructions,
                },
            }
        ext = {
            "image/png": "png",
            "image/jpeg": "jpg",
            "image/webp": "webp",
            "audio/wav": "wav",
            "audio/mpeg": "mp3",
        }[mime]
        key = f"generated/{job['id']}/{media_id}.{ext}"
        state["media"][media_id].update({"bucket": bucket, "object_key": key})
        await checkpoint()
        await db.upload(bucket, key, blob, mime)
        await db.insert(
            table,
            {
                "id": media_id,
                "bucket": bucket,
                "object_key": key,
                "file_hash": hashlib.sha256(blob).hexdigest(),
                **row,
            },
        )
        state["media"][media_id]["status"] = "stored"
        await checkpoint()
        cache[signature] = media_id
        return media_id

    for index, q in enumerate(batch.questions):
        qid = str(uuid5(UUID(job["id"]), f"question:{index}"))
        if await db.select("questions", id=f"eq.{qid}"):
            continue
        resolved = {}
        for e in elements(q):
            resolved[id(e)] = {
                "image_id": await media(e.image, "image"),
                "audio_id": await media(e.audio, "audio"),
            }
        records = []

        def add(table, _records=records, _qid=qid, **row):
            _records.append({"table": table, "row": {"question_id": _qid, **row}})

        if isinstance(q, Completion):
            add("completion_questions", stem_text=q.stem.text, **resolved[id(q.stem)])
            for pos, opt in enumerate(q.options):
                add(
                    "completion_options",
                    text_content=opt.text,
                    is_correct=opt.is_correct,
                    position=pos,
                    **resolved[id(opt)],
                )
        elif isinstance(q, Typing):
            add(
                "typing_questions",
                stem_text=q.stem.text,
                **resolved[id(q.stem)],
                answer_text=q.answer.text,
                completed_sentence=q.completed_sentence,
                case_sensitive=q.case_sensitive,
                answer_audio_id=resolved[id(q.answer)]["audio_id"],
            )
        elif isinstance(q, Matching):
            add("matching_questions")
            for pos, pair in enumerate(q.pairs):
                add(
                    "matching_pairs",
                    position=pos,
                    left_text=pair.left.text,
                    right_text=pair.right.text,
                    **{"left_" + k: v for k, v in resolved[id(pair.left)].items()},
                    **{"right_" + k: v for k, v in resolved[id(pair.right)].items()},
                )
        elif isinstance(q, Ordering):
            add(
                "ordering_questions",
                correct_sentence=q.answer.text,
                answer_audio_id=resolved[id(q.answer)]["audio_id"],
            )
            for pos, token in enumerate(q.tokens):
                add(
                    "ordering_tokens",
                    text_content=token.text,
                    correct_position=pos,
                    audio_id=resolved[id(token)]["audio_id"],
                )
        elif isinstance(q, Listening):
            add("listening_questions")
            for pos, item in enumerate(q.items):
                add(
                    "listening_items",
                    label=item.text,
                    spoken_text=item.audio.transcript,
                    correct_position=pos,
                    **resolved[id(item)],
                )
        await db.rpc(
            "save_generated_question",
            {
                "p_job": job["id"],
                "p_worker": worker,
                "p_lo": str(req.lo_id),
                "p_question": {
                    "id": qid,
                    "question_type": q.question_type,
                    "bloom_level": req.bloom_level,
                    "instruction_text": q.instruction_text,
                    "hint": q.hint,
                    "explanation": q.explanation,
                    "item_index": index,
                },
                "p_records": records,
            },
        )
    await db.patch(
        "generation_jobs",
        {"status": "completed", "error": None},
        id=f"eq.{job['id']}",
        worker_id=f"eq.{worker}",
        status="eq.running",
    )


async def heartbeat(db, job_id, worker):
    while True:
        await asyncio.sleep(db.s.worker_lease_seconds / 3)
        until = datetime.now(UTC) + timedelta(seconds=db.s.worker_lease_seconds)
        result = await db.patch(
            "generation_jobs",
            {"lease_until": until.isoformat()},
            id=f"eq.{job_id}",
            worker_id=f"eq.{worker}",
            status="eq.running",
        )
        if not result:
            raise RuntimeError("Worker lease lost")


async def run():
    settings = get_settings()
    worker = str(uuid4())
    async with httpx.AsyncClient(timeout=30, follow_redirects=False) as client:
        db = Database(settings, client)
        providers = Providers(settings, client)
        while True:
            try:
                jobs = await db.rpc(
                    "claim_generation_job",
                    {"p_worker": worker, "p_lease": settings.worker_lease_seconds},
                )
            except Exception as exc:
                log.error("Cannot claim job: %s (details withheld)", type(exc).__name__)
                await asyncio.sleep(10)
                continue
            if not jobs:
                await asyncio.sleep(settings.worker_poll_seconds)
                continue
            job = jobs[0]
            beat = asyncio.create_task(heartbeat(db, job["id"], worker))
            task = asyncio.create_task(process(db, providers, job, worker))
            try:
                done, _ = await asyncio.wait([beat, task], return_when=asyncio.FIRST_COMPLETED)
                for completed in done:
                    completed.result()
            except Exception as exc:
                # No automatic retry of billed TTS/text requests. Keep checkpoints for inspection.
                log.error("Job %s failed: %s", job["id"], type(exc).__name__)
                await db.patch(
                    "generation_jobs",
                    {
                        "status": "failed",
                        "error": f"{type(exc).__name__}: generation failed; inspect provider dashboard/checkpoint. No automatic retry.",
                    },
                    id=f"eq.{job['id']}",
                    worker_id=f"eq.{worker}",
                    status="eq.running",
                )
            finally:
                for pending in (beat, task):
                    pending.cancel()
                    with suppress(asyncio.CancelledError, Exception):
                        await pending


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    asyncio.run(run())
