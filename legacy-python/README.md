> ⚠️ **Phiên bản cũ, KHÔNG deploy.** Backend đang chạy là Cloudflare Worker ở thư mục gốc của repo (xem [README chính](../README.md)).
> Thư mục này được giữ để tham chiếu và để dùng `scripts/bootstrap.py` (tạo bucket + import LO vào Supabase).
> Migration nằm ở `../supabase/migrations/`, dữ liệu LO ở `../supabase/data/`. Chạy lệnh trong thư mục `legacy-python/`.

# QuestionBank AI Core (internal POC)

Python 3.12 + FastAPI + a **separate durable worker process**. This directory is a standalone repository; it does not import code from `front-end` or read a parent `.env` automatically.

## Setup

1. Install [uv](https://docs.astral.sh/uv/) and run `uv sync --python 3.12`.
2. Copy `.env.example` to `.env`. Copy existing credentials from your local workspace manually; do not commit them.
3. Use the Supabase **project API URL**, not the dashboard URL. Keep the secret/service-role key backend-only.
4. **No login in this POC.** The API has no authentication; all jobs belong to one fixed placeholder owner. Anyone who can reach the API can create billed generation jobs, so run it only on localhost / a private network.
5. Apply `../supabase/migrations/001_initial.sql`, `002_persistence.sql`, then `003_no_auth.sql` once, in Supabase SQL Editor or via MCP apply_migration. These files are for a fresh schema; do not re-run blindly on an existing schema. They do not create another Supabase project/database.
6. Bootstrap private storage buckets and import your LO files:

```bash
uv run python -m scripts.bootstrap --data-dir ../supabase/data
# Inspect the dry-run count, then:
uv run python -m scripts.bootstrap --data-dir ../supabase/data --apply
```

The current source dataset has 573 LO item rows across grades 1–4. This POC stores source unit/specific-LO labels on each leaf record, not the full prerequisite hierarchy. Provisional codes/UUIDs are derived from curriculum content; re-importing identical content is safe and ignores existing rows. Content changes create a new identity; review/merge revisions explicitly rather than silently overwriting. Original constraints, including known curriculum ambiguities, are preserved for review.

## Run two processes

```bash
# Terminal 1
uv run uvicorn app.main:app --reload --port 8000
# Terminal 2
uv run python -m app.worker
```

Or `docker compose up --build`. The API and worker share PostgreSQL as the job queue; no Redis needed for the POC. Deploy them on a persistent container host, not Vercel Functions. Vercel hosts only the independent frontend. Add the exact frontend origin to `CORS_ORIGINS`; no wildcard credentials.

## Provider configuration (no paid model is preselected)

Required for text:
- `OPENROUTER_API_KEY`
- `OPENROUTER_TEXT_MODEL`: model ID supporting JSON object output. A Pydantic schema is included in the prompt and the result is validated locally.

Required when audio is enabled:
- `OPENROUTER_AUDIO_MODEL`, `OPENROUTER_AUDIO_VOICE`
- `OPENROUTER_AUDIO_API=chat` (default): streamed `/chat/completions` with text+audio modalities. With `stream=true` the OpenAI audio models only accept `format: "pcm16"` (wav/mp3 return HTTP 400), so the worker requests pcm16, base64-decodes each SSE chunk and wraps the raw 16-bit mono PCM in a WAV container (`OPENROUTER_AUDIO_SAMPLE_RATE`, default 24000). Previously verified with `openai/gpt-audio-mini` (fallback `openai/gpt-audio`), voice `nova`.
- Alternatively `OPENROUTER_AUDIO_API=speech`: dedicated `/audio/speech`, raw MP3. Description is stored, and is sent as `instructions` only if `OPENROUTER_SPEECH_INSTRUCTIONS=true` and the chosen model supports it.
- Maya1 availability on OpenRouter has not been confirmed. Do not assume it works without a supported model ID/endpoint.

Images:
- `IMG_GEN_API_KEY`, `IMG_GEN_BASE_URL=https://genimg.tguru.vn:8000`.
- POST `/v1/images/generate` with `prompt` and `idempotency_key` only.
- Effective prompt = positive prompt + `\n\nAvoid: ` + negative prompt. Original fields are stored separately. This is not native negative-prompt conditioning.
- Persist provider job ID, poll `/v1/jobs/{job_id}`, download same-origin `/v1/images/...`, upload privately to Supabase. Requests do not follow redirects or forward API keys to arbitrary result hosts.
- Images are generated ONLY by the tguru server (no OpenRouter image model). tguru selects the model server-side (admin setting); the API has no model parameter. `images.model_name` stores `tguru:<model>` when the job status `params` reports a model, otherwise `tguru-server-default`.

References: https://genimg.tguru.vn:8000/openapi.json ; https://openrouter.ai/collections/audio-models ; https://openrouter.ai/blog/tutorials/text-to-speech/

## API and flow

All endpoints are open (no login, POC only). Active jobs are capped globally by `MAX_ACTIVE_JOBS`.

- `GET /v1/config`: safe model configuration/readiness (never API keys).
- `GET /v1/learning-objectives?grade=1&limit=200&offset=0`
- `POST /v1/jobs`: UUID request_key, lo_id, question_type, bloom_level 1–4, count 1–10, include_images, include_audio, instructions.
- `GET /v1/jobs`, `GET /v1/jobs/{id}`
- `GET /v1/questions?grade=&lo_id=&question_type=&status=&bloom_level=&job_id=&offset=&limit=`: review list of generated questions (newest first) with a short summary and LO; `has_more` for paging.
- `GET /v1/questions/{id}`: internal preview INCLUDING answers, detail rows and 10-minute signed media URLs. Not a learner endpoint.
- `PATCH /v1/questions/{id}/review`: `{"status":"approved"}` or `retired` after human inspection.

Flow: enqueue transaction → worker claims using SKIP LOCKED → text/asset specs from OpenRouter → validate entire batch → checkpoint → separate media generation → atomic question/detail insert via RPC → draft preview → human review. Provider calls are sequential within one job to keep costs and rate limits predictable.

## Schema

15 tables: learning_objectives, images, audios, generation_jobs, questions, question_los, completion_questions/options, typing_questions, matching_questions/pairs, ordering_questions/tokens, listening_questions/items. SPEAK is excluded. Child detail tables use composite foreign keys to enforce their question type. Each option/item has its own audio reference; identical requests within a batch can reuse the same media ID. LISTEN has no merged audio file. Matching has independent left/right item IDs. ORDER tokens are relational records, not one combined audio.

All tables enable RLS and revoke browser roles. The browser never talks to Supabase; data is fetched through the backend. RPC execution is granted only to service_role. Storage buckets are private. If the security advisor reports enabled RLS without policies, that is intentional here; do not add public policies to suppress the warning.

## Failure and cost semantics

- Same request key/config returns the same job; reuse with different config is rejected. Active jobs are capped atomically (`MAX_ACTIVE_JOBS`).
- Image requests use provider idempotency keys. OpenRouter text/TTS does not have a confirmed idempotency guarantee here; failed/stale jobs are NOT automatically replayed.
- Worker heartbeat extends leases. Stale jobs are marked failed on the next claim, preserving provider IDs and draft/media checkpoint. An already-submitted image job may continue running upstream after a timeout.
- Partial successful questions remain available. Media may be orphaned if upload succeeds but DB persistence fails; bucket/object keys are checkpointed. No automatic destructive cleanup.
- Human review is mandatory in the workflow. This POC does not claim ASR/vision validation, Bloom classification accuracy, semantic dedup, or production-scale cost optimisation. Only structural validation and exact within-batch duplicate checks are implemented.
- API read timeouts and provider 4xx/5xx errors fail safely without logging keys or full upstream response bodies.

## Tests

```bash
uv run pytest -q
uv run ruff check app scripts tests
```

Tests use fake credentials and mocked providers. No paid API calls. `tests/check_migrations.mjs` optionally runs migrations/transaction/security tests in local PGlite: install `@electric-sql/pglite` outside the app, set `PGLITE_MODULE` to its `dist/index.js`, run with Node. This emulates PostgreSQL/roles, not full Supabase Auth/Storage.
