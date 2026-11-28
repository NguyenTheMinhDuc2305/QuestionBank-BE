# QuestionBank — Backend

Backend của POC sinh câu hỏi tiếng Anh tiểu học bằng AI. Backend nhận yêu cầu từ giao diện, gọi AI sinh câu hỏi, ảnh và audio, rồi lưu kết quả vào Supabase để người dùng xem lại và duyệt.

| | |
|---|---|
| **Chạy ở đâu** | Cloudflare Workers + Workflows (gói Free) |
| **Địa chỉ** | https://questionbank-worker.nguyentheminhduc23052002.workers.dev |
| **Database + file** | Supabase (PostgreSQL + Storage) |
| **AI** | OpenRouter (câu hỏi, audio) · tguru (ảnh) |
| **Giao diện dùng backend này** | [QuestionBank-FE](https://github.com/NguyenTheMinhDuc2305/QuestionBank-FE) — https://question-bank-generator-six.vercel.app |
| **Đăng nhập** | Không có (POC mở cho mọi người test) |

---

## Mục lục
1. [Cấu trúc repo](#1-cấu-trúc-repo)
2. [Kiến trúc tổng quan](#2-kiến-trúc-tổng-quan)
3. [Luồng xử lý một job](#3-luồng-xử-lý-một-job)
4. [API](#4-api)
5. [Database (Supabase)](#5-database-supabase)
6. [Sinh nội dung: câu hỏi, ảnh, audio](#6-sinh-nội-dung-câu-hỏi-ảnh-audio)
7. [Cấu hình và key](#7-cấu-hình-và-key)
8. [Chạy local, test](#8-chạy-local-test)
9. [Deploy lên Cloudflare](#9-deploy-lên-cloudflare)
10. [Dựng Supabase từ đầu](#10-dựng-supabase-từ-đầu)
11. [Theo dõi và xử lý sự cố](#11-theo-dõi-và-xử-lý-sự-cố)
12. [Giới hạn và hạn chế](#12-giới-hạn-và-hạn-chế)

---

## 1. Cấu trúc repo

```
QuestionBank-BE/
├── src/                      # Code Worker (TypeScript) — backend đang chạy
│   ├── index.ts              # Điểm vào: export HTTP handler + class Workflow
│   ├── api.ts                # Các endpoint HTTP /v1/... (Hono)
│   ├── workflow.ts           # Workflow xử lý job (thay cho tiến trình worker Python cũ)
│   ├── providers.ts          # Gọi OpenRouter (text, audio) và tguru (ảnh)
│   ├── schemas.ts            # Kiểm tra dữ liệu AI trả về + yêu cầu tạo job (zod)
│   ├── plan.ts               # Tính trước ảnh/audio cần sinh và các dòng DB cần ghi
│   ├── supabase.ts           # Client Supabase REST + Storage (dùng secret key)
│   └── settings.ts           # Đọc cấu hình từ Worker Secrets
├── test/                     # 46 test (vitest, chạy trong runtime Workers), provider giả lập
├── scripts/
│   ├── secrets.mjs           # Đọc ../.env → tạo file secret (chỉ in TÊN key)
│   └── deploy.mjs            # Deploy kèm secret, luôn xóa file secret tạm sau đó
├── cloudflare.config.ts      # Cấu hình Worker + Workflow "questionbank-generate"
├── vite.config.ts            # Build/format/lint (Vite+ / Cloudflare Vite plugin)
├── package.json
├── .env.test                 # Giá trị GIẢ cho test (không phải key thật)
│
├── supabase/
│   ├── migrations/           # Schema database, chạy theo thứ tự 001 → 003
│   │   ├── 001_initial.sql       # 15 bảng, RLS, hàng đợi job
│   │   ├── 002_persistence.sql   # Hàm lưu câu hỏi (ghi tất cả hoặc không ghi gì), index
│   │   └── 003_no_auth.sql       # Bỏ ràng buộc với Supabase Auth (POC không đăng nhập)
│   └── data/
│       └── LO-Khối1.csv      # 102 learning objective khối 1 (đã import)
│
└── legacy-python/            # Backend FastAPI cũ — KHÔNG deploy. Giữ để tham chiếu
                              # và để dùng script import LO (scripts/bootstrap.py)
```

> **Key không nằm trong repo.** Mọi key nằm trong file `.env` ở **thư mục cha** của repo (`../.env`), file này không thuộc git. Xem [mục 7](#7-cấu-hình-và-key).

---

## 2. Kiến trúc tổng quan

```
 Trình duyệt ──► Vercel (giao diện, KHÔNG có key)
                      │  fetch https://questionbank-worker…workers.dev/v1/...
                      ▼
            ┌──────────────────────────────────────────────┐
            │ Cloudflare Worker  "questionbank-worker"      │
            │  • API (src/api.ts)                           │
            │  • Workflow "questionbank-generate"           │
            │    (src/workflow.ts)                          │
            │  • Key: Worker Secrets (mã hóa)               │
            └───────┬───────────────┬──────────────┬───────┘
                    │               │              │
            OpenRouter         tguru (ảnh)     Supabase
          (câu hỏi, audio)                  (database + Storage)
```

**Tại sao Cloudflare Workers + Workflows?**
- Sinh một bộ câu hỏi có ảnh/audio mất 1–3 phút, riêng ảnh tguru có thể chờ vài phút. Backend cần một tiến trình chạy nền lâu và không mất tiến độ nếu bị gián đoạn.
- **Workflows** lưu kết quả từng bước. Workflow bị dừng giữa chừng thì chạy tiếp từ bước dang dở, không gọi lại AI (không tốn tiền hai lần). Trong lúc chờ (`step.sleep`), Workflow không tốn CPU.
- Không cần thuê hay quản lý máy chủ. Key nằm trong Worker Secrets, không lộ ra trình duyệt.
- Backend Python cũ (FastAPI + tiến trình worker chạy mãi) cần một máy chạy 24/7, nên không đặt được lên Vercel hay Workers. Vì vậy backend đã được viết lại bằng TypeScript; logic giữ nguyên.

**Vai trò của Supabase:** chỉ để lưu trữ (database + file). Supabase không chạy code backend nào và không dùng Supabase Auth.

---

## 3. Luồng xử lý một job

### 3.1 Tạo job (`POST /v1/jobs`)
1. Kiểm tra yêu cầu (`GenerationRequest` trong `src/schemas.ts`): dạng bài, `lo_id`, Bloom 1–4, số câu 1–10, có ảnh/audio, yêu cầu bổ sung.
2. Kiểm tra đủ cấu hình (thiếu key thì trả 503 kèm tên biến còn thiếu, không bao giờ kèm giá trị).
3. **Chống tạo trùng:** gửi lại cùng `request_key` với cùng cấu hình thì nhận lại job cũ; cùng key nhưng khác cấu hình thì trả 409.
4. Gọi hàm SQL `enqueue_generation_job`, hàm này giới hạn số job đang chạy (`MAX_ACTIVE_JOBS`, mặc định 3; vượt thì trả 429). Giao diện tự chờ rồi thử lại.
5. Khởi chạy Workflow instance với **id = job id**, rồi trả job về ngay (HTTP 202). Giao diện hỏi trạng thái job mỗi 5 giây.

### 3.2 Workflow sinh nội dung (`src/workflow.ts`)

Mỗi việc là một **step** riêng. Kết quả step được Cloudflare lưu lại nên không bị làm lại:

| Step | Việc | Thử lại |
|---|---|---|
| `load job` | Đọc job + LO từ Supabase | 2 lần |
| `mark running` | `status = running`, `worker_id = job id` | 2 lần |
| `generate draft` | OpenRouter sinh **toàn bộ câu hỏi** dạng JSON → kiểm tra chặt | **Tối đa 1 lần** (tốn tiền); không thử lại khi lỗi 4xx (key/model sai) |
| `checkpoint draft` | Lưu bản nháp vào `generation_jobs.checkpoint` | 2 lần |
| `image N submit` | Gửi yêu cầu ảnh tới tguru (`idempotency_key` = id ảnh, gửi lại không sinh ảnh mới) | Tối đa 1 lần |
| `image N wait k` / `image N poll k` | Ngủ `IMAGE_POLL_SECONDS` (mặc định 10 giây) → hỏi trạng thái | 2 lần mỗi lần hỏi |
| `image N store` | Tải ảnh (cùng domain tguru) → upload Storage → ghi bảng `images` | 2 lần |
| `audio N` | Sinh audio → upload → ghi bảng `audios` (gộp 1 step vì file audio có thể > 1 MiB) | Tối đa 1 lần |
| `save question N` | Hàm SQL `save_generated_question`: ghi câu hỏi + các dòng chi tiết **trong một transaction** | 2 lần |
| `mark completed` | `status = completed` | 2 lần |
| `mark failed` | Khi có lỗi: `status = failed` + thông báo lỗi an toàn | 2 lần |

**An toàn khi chạy lại:**
- Id của ảnh, audio và câu hỏi được tính cố định từ job id (UUID v5), nên chạy lại vẫn ra đúng id cũ.
- Upload dùng `x-upsert` với tên file cố định, ghi đè chứ không tạo bản trùng. Ghi DB dùng "bỏ qua nếu đã có".
- Ảnh/audio có nội dung giống hệt nhau trong cùng một job chỉ sinh **một lần** rồi dùng chung.

### 3.3 Chia job thành chuỗi instance (giới hạn gói Free)

Gói Workers Free chỉ cho **50 lần gọi ra ngoài mỗi lần chạy**, và Cloudflare có thể chạy cả một instance Workflow (kể cả các đoạn ngủ ngắn) trong **một lần chạy**. Một job nhiều ảnh/audio sẽ vượt giới hạn này. Thực tế đã gặp lỗi `Too many subrequests` khi job có 5 ảnh + 5 audio.

Cách giải quyết (`BUDGET = 40`, bảng `COST` trong `src/workflow.ts`):
- Mỗi loại step có chi phí cố định (số lần gọi ra ngoài tối đa). Ví dụ ảnh: gửi 1, hỏi 1, lưu 3; audio: 4.
- Trước mỗi step, Workflow tính xem còn đủ "ngân sách" 40 không. Không đủ thì khởi chạy **instance kế tiếp** `<job id>-1`, `<job id>-2`, … kèm **con trỏ** (đang ở ảnh/audio/câu thứ mấy, job tguru nào đang chờ, đã hỏi bao nhiêu lần). Instance hiện tại kết thúc.
- 10 lần gọi còn dư được để dành cho thử lại và bước `mark failed`.
- Vì chi phí là hằng số, cách chia luôn giống nhau khi Workflow chạy lại.

Ví dụ thực tế: 1 câu COMP_SEL có 5 ảnh + 5 audio chạy qua 2 instance (24 + 9 step), xong trong khoảng 80 giây.

---

## 4. API

Mọi endpoint trả JSON. Không cần xác thực. CORS chỉ cho phép các domain trong `CORS_ORIGINS`.

| Method + đường dẫn | Mô tả |
|---|---|
| `GET /health` | `{"status":"ok"}` |
| `GET /v1/config` | Model đang dùng; `missing_text_settings` / `missing_media_settings` (tên biến còn thiếu) |
| `GET /v1/learning-objectives?grade=&offset=&limit=` | Danh sách LO (tối đa 1000/lần) |
| `POST /v1/jobs` | Tạo job (xem bên dưới). Trả **202** + job |
| `GET /v1/jobs` | 50 job gần nhất |
| `GET /v1/jobs/:id` | Job + danh sách câu đã tạo (`questions`) |
| `GET /v1/questions?grade=&lo_id=&question_type=&status=&bloom_level=&job_id=&offset=&limit=` | Danh sách câu (mới nhất trước), kèm `summary` (một dòng tóm tắt) và `lo`; `has_more` để phân trang |
| `GET /v1/questions/:id` | Chi tiết câu: `detail` (bảng chính theo dạng bài), `items` (đáp án/cặp/token/item), `media` (kèm **link có hạn 10 phút**), `learning_objectives` |
| `PATCH /v1/questions/:id/review` | Body `{"status":"approved"}` hoặc `{"status":"retired"}` |

**Body tạo job:**
```json
{
  "request_key": "uuid do client sinh (chống tạo trùng)",
  "lo_id": "uuid của learning objective",
  "question_type": "COMP_SEL | TYPING | MATCH | ORDER | LISTEN",
  "bloom_level": 1,
  "count": 3,
  "include_images": true,
  "include_audio": true,
  "instructions": "yêu cầu bổ sung (tùy chọn, ≤ 2000 ký tự)"
}
```
Ràng buộc: LISTEN bắt buộc có cả ảnh và audio; ORDER không có ảnh.

**Mã lỗi:** `422` sai dữ liệu · `404` không tìm thấy · `409` `request_key` đã dùng với cấu hình khác · `429` đang có quá nhiều job chạy · `503` thiếu cấu hình hoặc database lỗi (không lộ chi tiết nội bộ).

---

## 5. Database (Supabase)

### 5.1 Bảng
| Bảng | Nội dung |
|---|---|
| `learning_objectives` | LO: khối, unit, tên chung, tên cụ thể, phân loại (Từ vựng/Ngữ pháp), nội dung |
| `generation_jobs` | Job: cấu hình, trạng thái (`queued/running/completed/failed`), `checkpoint` (bản nháp từ AI), lỗi |
| `questions` | Câu hỏi: dạng bài, Bloom, trạng thái duyệt (`draft/approved/retired`), hint, giải thích |
| `question_los` | Liên kết câu hỏi ↔ LO |
| `images`, `audios` | Thông tin file: bucket, đường dẫn, prompt/negative prompt hoặc transcript, model, hash |
| `completion_questions`, `completion_options` | COMP_SEL: câu có chỗ trống + 4–8 đáp án (đúng 1 đáp án đúng) |
| `typing_questions` | TYPING: câu có chỗ trống + đáp án + câu đầy đủ |
| `matching_questions`, `matching_pairs` | MATCH: các cặp trái ↔ phải |
| `ordering_questions`, `ordering_tokens` | ORDER: các từ/cụm theo thứ tự đúng + câu đầy đủ |
| `listening_questions`, `listening_items` | LISTEN: các item theo thứ tự đúng, mỗi item 1 ảnh + 1 audio |

Bảng chi tiết dùng khóa ngoại kép `(question_id, question_type)`, nên không thể gắn chi tiết sai dạng bài vào một câu.

### 5.2 Hàm SQL
| Hàm | Dùng để |
|---|---|
| `enqueue_generation_job` | Tạo job, chống trùng và giới hạn số job đang chạy (dùng khóa advisory, an toàn khi nhiều request đến cùng lúc) |
| `save_generated_question` | Ghi câu hỏi + chi tiết trong 1 transaction; kiểm tra quyền ghi theo `worker_id`; kiểm tra lại "đúng 1 đáp án đúng" |
| `claim_generation_job` | Chỉ dùng cho backend Python cũ |

### 5.3 Storage
Hai bucket **private**: `question-images` (png/jpeg/webp) và `question-audios` (wav/mpeg), giới hạn 20 MB mỗi file. File nằm ở `generated/<job id>/<media id>.<ext>`. Trình duyệt chỉ mở được qua **link ký tạm 10 phút** do API trả về.

### 5.4 Bảo mật
- Mọi bảng **bật RLS**; vai trò `anon`/`authenticated` bị thu hồi mọi quyền; hàm SQL chỉ `service_role` gọi được. Đã thử bằng key public: đọc bảng bị từ chối (42501), không gọi được hàm, không đọc được file.
- Supabase Security Advisor sẽ báo `rls_enabled_no_policy` cho 15 bảng. **Cảnh báo này là cố ý theo thiết kế; không thêm policy public để tắt nó.**

---

## 6. Sinh nội dung: câu hỏi, ảnh, audio

### 6.1 Câu hỏi (OpenRouter text)
- Gửi một lần cho cả job: prompt hệ thống (quy tắc cho 5 dạng bài, hint/giải thích bằng tiếng Việt), cấu hình job, LO, và **JSON Schema** của kết quả mong muốn.
- Kết quả được kiểm tra chặt (`src/schemas.ts`):
  - COMP_SEL: đúng 1 chỗ `___`, đúng 1 đáp án đúng, không có đáp án trùng.
  - TYPING: câu đầy đủ phải đúng bằng câu có chỗ trống thay `___` bằng đáp án.
  - MATCH: hai cột không có giá trị trùng.
  - ORDER: các token ghép lại đúng bằng câu; tối đa 10 từ; không có ảnh.
  - LISTEN: mỗi item có ảnh + audio riêng.
  - Chung: đủ số câu đã yêu cầu, đúng dạng bài, không có câu trùng y hệt, không có ảnh/audio ngoài yêu cầu; có audio thì mọi đáp án/item đều phải có audio riêng.
- Kết quả sai → job `failed` với lý do ngắn gọn (không ghi lại toàn bộ output của AI).

### 6.2 Ảnh (tguru)
- `POST /v1/images/generate` với `prompt` + `\n\nAvoid: ` + negative prompt (tguru không có tham số negative prompt riêng) và `idempotency_key`.
- Hỏi trạng thái `GET /v1/jobs/{id}` tới khi có `image_url`, rồi tải ảnh. **Chỉ tải từ đúng domain tguru qua HTTPS, không đi theo redirect**, để key không bị gửi tới nơi khác.
- Model do server tguru chọn. Tên model được lưu vào `images.model_name` dạng `tguru:<model>` nếu tguru báo, không thì lưu `tguru-server-default`.

### 6.3 Audio (OpenRouter, giữ cách làm của bản QuestionBank cũ)
- `chat/completions` stream, `modalities: ["text","audio"]`, `format: "pcm16"` (khi stream, model chỉ nhận `pcm16`).
- Model `openai/gpt-audio-mini`; lỗi thì thử `openai/gpt-audio`; giọng `nova`. Gặp lỗi 401/402/403/503 thì dừng luôn, không thử model dự phòng. Thử lại 1 lần khi lỗi mạng hoặc 429/5xx.
- Giải mã base64 **riêng từng chunk** rồi bọc thành **WAV 24 kHz mono 16-bit**.
- Prompt hệ thống chép nguyên văn từ bản cũ ("…Vietnamese Grade 1 children… slowly and clearly…").

---

## 7. Cấu hình và key

Mọi cấu hình nằm trong **`../.env`** (thư mục cha của repo, ngoài git). Khi deploy, `scripts/deploy.mjs` đọc file này và upload thành **Worker Secrets**, lưu mã hóa trên Cloudflare và không ai đọc lại được.

| Biến | Bắt buộc | Mặc định / ghi chú |
|---|---|---|
| `SUPABASE_URL` | ✅ | `https://<ref>.supabase.co` (không dùng link dashboard) |
| `SUPABASE_SECRET_KEY` | ✅ | `sb_secret_…` |
| `SUPABASE_IMAGES_BUCKET` / `SUPABASE_AUDIOS_BUCKET` | | `question-images` / `question-audios` |
| `CORS_ORIGINS` | | JSON list các domain giao diện, ví dụ `["http://localhost:3000","https://question-bank-generator-six.vercel.app"]` |
| `OPENROUTER_API_KEY` | ✅ khi tạo câu | |
| `OPENROUTER_TEXT_MODEL` | ✅ khi tạo câu | Không có mặc định (vì quyết định chi phí). Đang dùng `anthropic/claude-sonnet-5.5` |
| `OPENROUTER_AUDIO_MODEL` / `_FALLBACK_MODEL` / `_VOICE` | | `openai/gpt-audio-mini` / `openai/gpt-audio` / `nova` |
| `OPENROUTER_AUDIO_API` | | `chat` (hoặc `speech` = `/audio/speech` trả MP3) |
| `OPENROUTER_AUDIO_SAMPLE_RATE` | | `24000` |
| `IMG_GEN_API_KEY` | ✅ khi có ảnh | Key tguru |
| `IMG_GEN_BASE_URL` | | `https://genimg.tguru.vn:8000` |
| `IMAGE_POLL_SECONDS` | | `10` (giữ ≥ 10 để tiết kiệm step) |
| `IMAGE_TIMEOUT_SECONDS` | | `600` |
| `MAX_MEDIA_BYTES` | | `20971520` (20 MB) |
| `MAX_ACTIVE_JOBS` | | `3` |

**Quy tắc:**
- Không commit `.env`, `.dev.vars` hay `.secrets*.json`; `.gitignore` đã chặn cả ba.
- `scripts/secrets.mjs` chỉ in **tên** key, không in giá trị.
- Thông báo lỗi lưu vào DB hoặc trả về API chỉ chứa mã HTTP và tên lỗi, không chứa nội dung trả về từ provider hay key.

---

## 8. Chạy local, test

Yêu cầu: **Node.js 22.23+ hoặc 24.22+**, CLI `cf` (`npm i -g cf`).

```bash
npm ci
npm test          # 46 test: schema, provider (giả lập), API, Workflow (kể cả chia chuỗi instance)
npm run check     # format + lint + typecheck
npm run dev       # tạo .dev.vars từ ../.env rồi chạy Worker tại http://localhost:8787
```

- `npm run dev` dùng **Supabase thật và key thật**: tạo job ở local sẽ tốn tiền thật. Muốn thử mà không tốn tiền thì để trống key OpenRouter; API sẽ trả 503 "thiếu cấu hình".
- Giao diện local (`QuestionBank-FE`) trỏ tới Worker local bằng `NEXT_PUBLIC_AI_CORE_URL=http://localhost:8787`.
- Test không gọi API thật; mọi request ra ngoài đều được giả lập.

---

## 9. Deploy lên Cloudflare

```bash
cf auth login     # lần đầu trên máy: mở trình duyệt, đăng nhập đúng account rồi bấm Approve
cf auth whoami    # kiểm tra đang đăng nhập đúng account
npm run deploy
```

`npm run deploy` (`scripts/deploy.mjs`) làm các bước:
1. Đọc `../.env` → tạo `.secrets.deploy.json` (chỉ lấy các biến backend cần, bỏ biến trống).
2. `cf deploy --secrets-file .secrets.deploy.json`: build → upload code + secret → tạo/cập nhật Workflow `questionbank-generate`.
3. **Luôn xóa** `.secrets.deploy.json`, kể cả khi deploy lỗi.

Sau khi deploy, kiểm tra:
```bash
curl https://questionbank-worker.nguyentheminhduc23052002.workers.dev/health
curl https://questionbank-worker.nguyentheminhduc23052002.workers.dev/v1/config   # missing_* phải rỗng
```

**Khi nào cần deploy lại:** sửa code trong `src/`; đổi key hoặc cấu hình trong `../.env`; thêm domain giao diện vào `CORS_ORIGINS`.

**Cấu hình Worker** (`cloudflare.config.ts`):
- Tên Worker `questionbank-worker`; Workflow `questionbank-generate`, chạy tối đa 3 instance cùng lúc, tối đa 1000 step mỗi instance, giữ lịch sử 3 ngày.
- Khi deploy, chỉ `SUPABASE_URL` và `SUPABASE_SECRET_KEY` là bắt buộc, để có thể deploy dù chưa điền key AI.
- Bật observability (log) trên Cloudflare.

---

## 10. Dựng Supabase từ đầu

Làm khi chuyển sang một project Supabase mới:

1. **Schema:** Supabase Dashboard → SQL Editor → chạy lần lượt `supabase/migrations/001_initial.sql`, `002_persistence.sql`, `003_no_auth.sql`. Chỉ chạy **một lần** trên database trống.
2. **Key:** cập nhật `SUPABASE_URL` và `SUPABASE_SECRET_KEY` trong `../.env`.
3. **Bucket + LO** (dùng script Python trong `legacy-python/`):
   ```bash
   cd legacy-python
   cp ../../.env .env                      # script đọc .env trong thư mục này
   uv sync --python 3.12
   uv run python -m scripts.bootstrap --data-dir ../supabase/data            # chạy thử: chỉ đếm số LO
   uv run python -m scripts.bootstrap --data-dir ../supabase/data --apply    # tạo bucket private + import
   rm .env                                 # xóa bản sao key
   ```
   - File LO phải có tên dạng `*Khối*.csv`, cùng định dạng với `LO-Khối1.csv` (2 dòng tiêu đề, 11 cột).
   - Chạy lại nhiều lần vẫn an toàn: id LO tính từ nội dung, dòng đã có thì bỏ qua.
4. **Deploy lại Worker** ([mục 9](#9-deploy-lên-cloudflare)).

**Thêm LO khối 2–4:** thêm `LO-Khối2.csv`… vào `supabase/data/` rồi chạy lại bước 3.

---

## 11. Theo dõi và xử lý sự cố

| Việc | Cách làm |
|---|---|
| Xem từng step của một job | `cf workflows instances get <job id> --workflow-name questionbank-generate` (job dài có thêm `<job id>-1`, `-2`, …) |
| Xem log trực tiếp | `npx wrangler tail questionbank-worker` |
| Dashboard | Cloudflare → Workers & Pages → `questionbank-worker` → Logs / Workflows |
| Job `failed` | Xem trường `error` (`GET /v1/jobs/:id`). Ví dụ: `ProviderError: OpenRouter text HTTP 401` → key sai; `Model output failed validation: …` → AI trả sai cấu trúc, tạo lại job |
| Job kẹt `running` | Xem instance cuối của chuỗi. Nếu instance đã lỗi mà job không chuyển trạng thái, cập nhật tay trong SQL Editor: `update generation_jobs set status='failed' where id='…'` |
| `Too many subrequests` | Một loại step đang tốn nhiều lần gọi hơn giá trị trong `COST`: tăng `COST` hoặc giảm `BUDGET` trong `src/workflow.ts` |
| API trả 503 | `GET /v1/config` để xem biến còn thiếu; hoặc Supabase lỗi/sai key |
| API trả 429 | Đang có 3 job chạy; chờ job xong (giao diện tự chờ và thử lại) |

---

## 12. Giới hạn và hạn chế

**Gói Cloudflare Workers Free:**
| Giới hạn | Giá trị | Ghi chú |
|---|---|---|
| Request | 100.000/ngày | Thoải mái |
| Workflow step | 3.000/ngày | 1 câu COMP_SEL có 5 ảnh + 5 audio tốn khoảng 33 step |
| Gọi ra ngoài | 50 mỗi lần chạy | Đã xử lý bằng chuỗi instance ([3.3](#33-chia-job-thành-chuỗi-instance-giới-hạn-gói-free)) |
| CPU | 10 ms mỗi step | Thời gian chờ mạng không tính |

Nâng lên Workers Paid (5 USD/tháng) nếu cần nhiều hơn; code không phải đổi.

**Hạn chế của POC:**
- Không có đăng nhập; ai có link cũng tạo được job (tốn tiền OpenRouter/tguru). Nên đặt giới hạn chi tiêu trên OpenRouter.
- Chưa hỗ trợ dạng RESP_SEL và SPEAK.
- Chưa có API tạo lại từng ảnh/audio.
- Mỗi job chỉ cho 1 LO (giao diện tạo nhiều job khi chọn nhiều LO).
- Chỉ kiểm tra trùng y hệt trong cùng một job; chưa kiểm tra trùng theo ngữ nghĩa. Không có kiểm tra ảnh/audio tự động (người duyệt kiểm tra bằng mắt và tai).
