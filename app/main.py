from contextlib import asynccontextmanager
from typing import Literal
from uuid import UUID

import httpx
from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel

from app.config import get_settings
from app.db import Database, DatabaseError
from app.schemas import GenerationRequest

bearer = HTTPBearer(auto_error=False)


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
    allow_headers=["Authorization", "Content-Type"],
)


def database(request: Request) -> Database:
    return request.app.state.db


async def admin(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer),
    db: Database = Depends(database),
):
    if not credentials:
        raise HTTPException(401, "Login required")
    user = await db.user(credentials.credentials)
    if not user or not user.get("id"):
        raise HTTPException(401, "Invalid or expired session")
    if not user.get("email_confirmed_at") or user.get("email", "").casefold() not in {
        e.casefold() for e in db.s.admin_emails
    }:
        raise HTTPException(403, "Internal access only; ask admin to configure ADMIN_EMAILS")
    return user


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


@app.get("/v1/config", dependencies=[Depends(admin)])
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


@app.get("/v1/learning-objectives", dependencies=[Depends(admin)])
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
    body: GenerationRequest, user=Depends(admin), db: Database = Depends(database)
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
            "p_limit": db.s.max_active_jobs_per_user,
        },
    )


@app.get("/v1/jobs")
async def jobs(user=Depends(admin), db: Database = Depends(database)):
    return await db.select(
        "generation_jobs",
        select="id,status,config,completed_count,error,created_at",
        owner_id=f"eq.{user['id']}",
        order="created_at.desc",
        limit=50,
    )


@app.get("/v1/jobs/{job_id}")
async def job(job_id: UUID, user=Depends(admin), db: Database = Depends(database)):
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


async def owned_question(qid, user, db):
    rows = await db.select("questions", id=f"eq.{qid}")
    if not rows or not await db.select(
        "generation_jobs", id=f"eq.{rows[0]['job_id']}", owner_id=f"eq.{user['id']}"
    ):
        raise HTTPException(404, "Question not found")
    return rows[0]


@app.get("/v1/questions/{question_id}")
async def question(question_id: UUID, user=Depends(admin), db: Database = Depends(database)):
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
    return q  # Internal authoring endpoint: includes answers; not a learner API.


class Review(BaseModel):
    status: Literal["approved", "retired"]


@app.patch("/v1/questions/{question_id}/review")
async def review(
    question_id: UUID, body: Review, user=Depends(admin), db: Database = Depends(database)
):
    await owned_question(question_id, user, db)
    return await db.patch("questions", {"status": body.status}, id=f"eq.{question_id}")
