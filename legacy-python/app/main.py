from contextlib import asynccontextmanager
from typing import Literal
from uuid import UUID

import httpx
from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from app.config import get_settings
from app.db import Database, DatabaseError
from app.schemas import GenerationRequest

# POC: no login. Every job belongs to one fixed owner id. Anyone who can reach this API can
# create (billed) jobs, so only expose it on localhost/private network.
POC_OWNER_ID = "00000000-0000-0000-0000-000000000000"


@asynccontextmanager
async def lifespan(app: FastAPI):
    async with httpx.AsyncClient(timeout=30, follow_redirects=False) as client:
        app.state.db = Database(get_settings(), client)
        yield


app = FastAPI(title="QuestionBank AI Core", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=get_settings().cors_origins,
    allow_methods=["GET", "POST", "PATCH"],
    allow_headers=["Content-Type"],
)


def database(request: Request) -> Database:
    return request.app.state.db


def owner() -> dict:
    return {"id": POC_OWNER_ID}


@app.exception_handler(DatabaseError)
async def database_error(_request, _error):
    return JSONResponse(
        status_code=503,
        content={
            "detail": "Database operation failed. Verify migrations and backend configuration."
        },
    )


@app.exception_handler(httpx.HTTPError)
async def network_error(_request, _error):
    return JSONResponse(status_code=503, content={"detail": "Upstream connection unavailable"})


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/v1/config")
async def config():
    s = get_settings()
    return {
        "question_types": ["COMP_SEL", "TYPING", "MATCH", "ORDER", "LISTEN"],
        "text_model": s.openrouter_text_model,
        "audio_model": s.openrouter_audio_model,
        "audio_voice": s.openrouter_audio_voice,
        "missing_text_settings": s.generation_errors(images=False, audio=False),
        "missing_media_settings": s.generation_errors(images=True, audio=True),
    }


@app.get("/v1/learning-objectives")
async def los(
    grade: int | None = Query(None, ge=1, le=12),
    offset: int = Query(0, ge=0),
    limit: int = Query(200, ge=1, le=1000),
    db: Database = Depends(database),
):
    params = {"order": "grade,unit,code", "offset": offset, "limit": limit}
    if grade:
        params["grade"] = f"eq.{grade}"
    return await db.select("learning_objectives", **params)


@app.post("/v1/jobs", status_code=202)
async def create_job(
    body: GenerationRequest, user=Depends(owner), db: Database = Depends(database)
):
    missing = db.s.generation_errors(images=body.include_images, audio=body.include_audio)
    if missing:
        raise HTTPException(503, {"missing_settings": missing})
    if not await db.select("learning_objectives", id=f"eq.{body.lo_id}"):
        raise HTTPException(404, "Learning objective not found")
    config = body.model_dump(mode="json", exclude={"request_key"})
    old = await db.select(
        "generation_jobs", owner_id=f"eq.{user['id']}", request_key=f"eq.{body.request_key}"
    )
    if old:
        if old[0]["config"] != config:
            raise HTTPException(409, "Idempotency key already used with different config")
        return old[0]
    # Atomic per-user quota check in PostgreSQL handles concurrent requests.
    return await db.rpc(
        "enqueue_generation_job",
        {
            "p_owner": user["id"],
            "p_key": str(body.request_key),
            "p_config": config,
            "p_limit": db.s.max_active_jobs,
        },
    )


@app.get("/v1/jobs")
async def jobs(user=Depends(owner), db: Database = Depends(database)):
    return await db.select(
        "generation_jobs",
        select="id,status,config,completed_count,error,created_at",
        owner_id=f"eq.{user['id']}",
        order="created_at.desc",
        limit=50,
    )


@app.get("/v1/jobs/{job_id}")
async def job(job_id: UUID, user=Depends(owner), db: Database = Depends(database)):
    rows = await db.select("generation_jobs", id=f"eq.{job_id}", owner_id=f"eq.{user['id']}")
    if not rows:
        raise HTTPException(404, "Job not found")
    row = rows[0]
    row.pop("checkpoint", None)
    row["questions"] = await db.select("questions", job_id=f"eq.{job_id}", order="item_index")
    return row


DETAILS = {
    "COMP_SEL": ("completion_questions", "completion_options", "position"),
    "TYPING": ("typing_questions", None, None),
    "MATCH": ("matching_questions", "matching_pairs", "position"),
    "ORDER": ("ordering_questions", "ordering_tokens", "correct_position"),
    "LISTEN": ("listening_questions", "listening_items", "correct_position"),
}


LO_FIELDS = "id,code,grade,unit,specific_name,content"
LIST_SELECT = (
    "id,question_type,bloom_level,status,instruction_text,created_at,job_id,item_index,"
    f"question_los!inner(lo_id,learning_objectives!inner({LO_FIELDS})),"
    "completion_questions(stem_text),typing_questions(stem_text,answer_text),"
    "ordering_questions(correct_sentence),"
    "matching_questions(matching_pairs(left_text,right_text,position)),"
    "listening_questions(listening_items(label,correct_position))"
)


def _one(value):
    """PostgREST returns one-to-one embeds as an object (or a list on older versions)."""
    if isinstance(value, list):
        return value[0] if value else None
    return value


def summarize(row: dict) -> dict:
    """Flatten an embedded question row into a short list item."""
    text = ""
    if c := _one(row.get("completion_questions")):
        text = c["stem_text"]
    elif t := _one(row.get("typing_questions")):
        text = f"{t['stem_text']}  →  {t['answer_text']}"
    elif o := _one(row.get("ordering_questions")):
        text = o["correct_sentence"]
    elif m := _one(row.get("matching_questions")):
        pairs = sorted(m.get("matching_pairs") or [], key=lambda p: p["position"])
        text = " · ".join(f"{p['left_text']} ↔ {p['right_text']}" for p in pairs)
    elif li := _one(row.get("listening_questions")):
        items = sorted(li.get("listening_items") or [], key=lambda i: i["correct_position"])
        text = " · ".join(i["label"] for i in items)
    links = row.get("question_los") or []
    lo = links[0].get("learning_objectives") if links else None
    return {
        "id": row["id"],
        "question_type": row["question_type"],
        "bloom_level": row["bloom_level"],
        "status": row["status"],
        "instruction_text": row["instruction_text"],
        "created_at": row["created_at"],
        "job_id": row["job_id"],
        "item_index": row["item_index"],
        "summary": text,
        "lo": lo,
    }


@app.get("/v1/questions")
async def list_questions(
    grade: int | None = Query(None, ge=1, le=12),
    lo_id: UUID | None = None,
    question_type: Literal["COMP_SEL", "TYPING", "MATCH", "ORDER", "LISTEN"] | None = None,
    status: Literal["draft", "approved", "retired"] | None = None,
    bloom_level: int | None = Query(None, ge=1, le=4),
    job_id: UUID | None = None,
    offset: int = Query(0, ge=0),
    limit: int = Query(20, ge=1, le=100),
    db: Database = Depends(database),
):
    """Review list of previously generated questions (newest first)."""
    params = {
        "select": LIST_SELECT,
        "order": "created_at.desc,item_index.asc",
        "offset": offset,
        "limit": limit + 1,  # one extra row tells the client whether another page exists
    }
    if grade:
        params["question_los.learning_objectives.grade"] = f"eq.{grade}"
    if lo_id:
        params["question_los.lo_id"] = f"eq.{lo_id}"
    if question_type:
        params["question_type"] = f"eq.{question_type}"
    if status:
        params["status"] = f"eq.{status}"
    if bloom_level:
        params["bloom_level"] = f"eq.{bloom_level}"
    if job_id:
        params["job_id"] = f"eq.{job_id}"
    rows = await db.select("questions", **params) or []
    return {
        "items": [summarize(r) for r in rows[:limit]],
        "offset": offset,
        "limit": limit,
        "has_more": len(rows) > limit,
    }


async def owned_question(qid, user, db):
    rows = await db.select("questions", id=f"eq.{qid}")
    if not rows or not await db.select(
        "generation_jobs", id=f"eq.{rows[0]['job_id']}", owner_id=f"eq.{user['id']}"
    ):
        raise HTTPException(404, "Question not found")
    return rows[0]


@app.get("/v1/questions/{question_id}")
async def question(question_id: UUID, user=Depends(owner), db: Database = Depends(database)):
    q = await owned_question(question_id, user, db)
    detail, children, order = DETAILS[q["question_type"]]
    q["detail"] = (await db.select(detail, question_id=f"eq.{question_id}"))[0]
    q["items"] = (
        await db.select(children, question_id=f"eq.{question_id}", order=order) if children else []
    )
    media = {}
    for row in [q["detail"], *q["items"]]:
        for key, value in row.items():
            if not value or not key.endswith(("image_id", "audio_id")) or value in media:
                continue
            table = "images" if key.endswith("image_id") else "audios"
            records = await db.select(table, id=f"eq.{value}")
            if records:
                record = records[0]
                media[value] = {
                    **record,
                    "kind": table,
                    "url": await db.signed_url(record["bucket"], record["object_key"]),
                }
    q["media"] = media
    links = await db.select(
        "question_los",
        select=f"is_primary,learning_objectives({LO_FIELDS})",
        question_id=f"eq.{question_id}",
    )
    q["learning_objectives"] = [
        link["learning_objectives"] for link in links or [] if link.get("learning_objectives")
    ]
    return q  # Internal authoring endpoint: includes answers; not a learner API.


class Review(BaseModel):
    status: Literal["approved", "retired"]


@app.patch("/v1/questions/{question_id}/review")
async def review(
    question_id: UUID, body: Review, user=Depends(owner), db: Database = Depends(database)
):
    await owned_question(question_id, user, db)
    return await db.patch("questions", {"status": body.status}, id=f"eq.{question_id}")
