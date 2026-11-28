// HTTP API (same endpoints and response shapes as the Python FastAPI backend).
import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import { stableJson } from "./plan.ts";
import { GenerationRequest, QUESTION_TYPES, describeZodError, jobConfig } from "./schemas.ts";
import { ConfigError, type Settings, generationErrors, loadSettings } from "./settings.ts";
import { Database, DatabaseError, type Row } from "./supabase.ts";

/** POC without login: every job belongs to this fixed owner. Do not expose real keys publicly. */
export const POC_OWNER_ID = "00000000-0000-0000-0000-000000000000";

type AppEnv = { Bindings: Env; Variables: { s: Settings; db: Database } };

class HttpError extends Error {
	constructor(
		readonly status: number,
		readonly detail: unknown,
	) {
		super(typeof detail === "string" ? detail : "HTTP error");
	}
}

const uuid = z.uuid();
function parseUuid(value: string, what: string): string {
	if (!uuid.safeParse(value).success) throw new HttpError(422, `${what} must be a UUID`);
	return value;
}

function intParam(
	value: string | undefined,
	name: string,
	fallback: number | null,
	min: number,
	max: number,
): number | null {
	if (value === undefined || value === "") return fallback;
	const n = Number(value);
	if (!Number.isInteger(n) || n < min || n > max)
		throw new HttpError(422, `${name} must be an integer between ${min} and ${max}`);
	return n;
}

function oneOf<T extends string>(
	value: string | undefined,
	name: string,
	allowed: readonly T[],
): T | null {
	if (value === undefined || value === "") return null;
	if (!(allowed as readonly string[]).includes(value))
		throw new HttpError(422, `${name} must be one of ${allowed.join(", ")}`);
	return value as T;
}

const DETAILS: Record<string, [string, string | null, string | null]> = {
	COMP_SEL: ["completion_questions", "completion_options", "position"],
	TYPING: ["typing_questions", null, null],
	MATCH: ["matching_questions", "matching_pairs", "position"],
	ORDER: ["ordering_questions", "ordering_tokens", "correct_position"],
	LISTEN: ["listening_questions", "listening_items", "correct_position"],
};

const LO_FIELDS = "id,code,grade,unit,specific_name,content";
const LIST_SELECT =
	"id,question_type,bloom_level,status,instruction_text,created_at,job_id,item_index," +
	`question_los!inner(lo_id,learning_objectives!inner(${LO_FIELDS})),` +
	"completion_questions(stem_text),typing_questions(stem_text,answer_text)," +
	"ordering_questions(correct_sentence)," +
	"matching_questions(matching_pairs(left_text,right_text,position))," +
	"listening_questions(listening_items(label,correct_position))";

const txt = (value: unknown): string =>
	typeof value === "string" || typeof value === "number" ? String(value) : "";

/** PostgREST returns one-to-one embeds as an object (older versions: a list). */
function one(value: unknown): Row | null {
	if (Array.isArray(value)) return (value[0] as Row | undefined) ?? null;
	return (value as Row | null) ?? null;
}

export function summarize(row: Row): Row {
	let text = "";
	const c = one(row.completion_questions);
	const t = one(row.typing_questions);
	const o = one(row.ordering_questions);
	const m = one(row.matching_questions);
	const l = one(row.listening_questions);
	if (c) text = txt(c.stem_text);
	else if (t) text = `${txt(t.stem_text)}  →  ${txt(t.answer_text)}`;
	else if (o) text = txt(o.correct_sentence);
	else if (m)
		text = ((m.matching_pairs as Row[]) ?? [])
			.toSorted((a, b) => Number(a.position) - Number(b.position))
			.map((p) => `${txt(p.left_text)} ↔ ${txt(p.right_text)}`)
			.join(" · ");
	else if (l)
		text = ((l.listening_items as Row[]) ?? [])
			.toSorted((a, b) => Number(a.correct_position) - Number(b.correct_position))
			.map((i) => txt(i.label))
			.join(" · ");
	const links = (row.question_los as Row[]) ?? [];
	return {
		id: row.id,
		question_type: row.question_type,
		bloom_level: row.bloom_level,
		status: row.status,
		instruction_text: row.instruction_text,
		created_at: row.created_at,
		job_id: row.job_id,
		item_index: row.item_index,
		summary: text,
		lo: links[0]?.learning_objectives ?? null,
	};
}

async function ownedQuestion(db: Database, id: string): Promise<Row> {
	const [q] = await db.select("questions", { id: `eq.${id}` });
	if (
		!q ||
		!(
			await db.select("generation_jobs", {
				select: "id",
				id: `eq.${txt(q.job_id)}`,
				owner_id: `eq.${POC_OWNER_ID}`,
			})
		).length
	)
		throw new HttpError(404, "Question not found");
	return q;
}

export function createApp() {
	const app = new Hono<AppEnv>();

	app.use("*", async (c, next) => {
		const origins = (() => {
			try {
				return loadSettings(c.env).corsOrigins;
			} catch {
				return [];
			}
		})();
		return cors({
			origin: (origin) => (origins.includes(origin) ? origin : null),
			allowMethods: ["GET", "POST", "PATCH"],
			allowHeaders: ["Content-Type"],
			maxAge: 600,
		})(c, next);
	});

	app.get("/health", (c) => c.json({ status: "ok" }));

	app.use("/v1/*", async (c, next) => {
		const s = loadSettings(c.env);
		c.set("s", s);
		c.set("db", new Database(s));
		await next();
	});

	app.get("/v1/config", (c) => {
		const s = c.get("s");
		return c.json({
			question_types: QUESTION_TYPES,
			text_model: s.openrouterTextModel,
			audio_model: s.openrouterAudioModel,
			audio_voice: s.openrouterAudioVoice,
			image_provider: "tguru",
			missing_text_settings: generationErrors(s, { images: false, audio: false }),
			missing_media_settings: generationErrors(s, { images: true, audio: true }),
		});
	});

	app.get("/v1/learning-objectives", async (c) => {
		const grade = intParam(c.req.query("grade"), "grade", null, 1, 12);
		const offset = intParam(c.req.query("offset"), "offset", 0, 0, 1_000_000);
		const limit = intParam(c.req.query("limit"), "limit", 200, 1, 1000);
		return c.json(
			await c.get("db").select("learning_objectives", {
				order: "grade,unit,code",
				offset: offset ?? 0,
				limit: limit ?? 200,
				grade: grade ? `eq.${grade}` : undefined,
			}),
		);
	});

	app.post("/v1/jobs", async (c) => {
		const s = c.get("s");
		const db = c.get("db");
		let raw: unknown;
		try {
			raw = await c.req.json();
		} catch {
			throw new HttpError(422, "Body must be JSON");
		}
		const parsed = GenerationRequest.safeParse(raw);
		if (!parsed.success) throw new HttpError(422, describeZodError(parsed.error));
		const body = parsed.data;
		const missing = generationErrors(s, { images: body.include_images, audio: body.include_audio });
		if (missing.length) throw new HttpError(503, { missing_settings: missing });
		if (!(await db.select("learning_objectives", { select: "id", id: `eq.${body.lo_id}` })).length)
			throw new HttpError(404, "Learning objective not found");
		const config = jobConfig(body);
		const [old] = await db.select("generation_jobs", {
			owner_id: `eq.${POC_OWNER_ID}`,
			request_key: `eq.${body.request_key}`,
		});
		if (old) {
			if (stableJson(old.config) !== stableJson(config))
				throw new HttpError(409, "Idempotency key already used with different config");
			return c.json(old, 202);
		}
		let job: Row;
		try {
			// Atomic per-owner active-job quota in PostgreSQL.
			job = await db.rpc<Row>("enqueue_generation_job", {
				p_owner: POC_OWNER_ID,
				p_key: body.request_key,
				p_config: config,
				p_limit: s.maxActiveJobs,
			});
		} catch (error) {
			if (error instanceof DatabaseError && error.status === 400)
				throw new HttpError(
					429,
					"Active job limit reached or duplicate request; wait for running jobs to finish",
				);
			throw error;
		}
		try {
			await c.env.GENERATE_JOB.create({ id: txt(job.id), params: { jobId: txt(job.id) } });
		} catch (error) {
			// Instance already exists (same job re-submitted concurrently) is fine; anything else fails the job.
			if (!/already exists|duplicate/i.test(String(error))) {
				await db.patch(
					"generation_jobs",
					{ status: "failed", error: "Could not start the generation Workflow." },
					{ id: `eq.${txt(job.id)}`, status: "eq.queued" },
				);
				throw new HttpError(503, "Could not start the generation Workflow");
			}
		}
		return c.json(job, 202);
	});

	app.get("/v1/jobs", async (c) =>
		c.json(
			await c.get("db").select("generation_jobs", {
				select: "id,status,config,completed_count,error,created_at",
				owner_id: `eq.${POC_OWNER_ID}`,
				order: "created_at.desc",
				limit: 50,
			}),
		),
	);

	app.get("/v1/jobs/:id", async (c) => {
		const id = parseUuid(c.req.param("id"), "job_id");
		const db = c.get("db");
		const [row] = await db.select("generation_jobs", {
			id: `eq.${id}`,
			owner_id: `eq.${POC_OWNER_ID}`,
		});
		if (!row) throw new HttpError(404, "Job not found");
		delete row.checkpoint;
		row.questions = await db.select("questions", { job_id: `eq.${id}`, order: "item_index" });
		return c.json(row);
	});

	app.get("/v1/questions", async (c) => {
		const q = (k: string) => c.req.query(k);
		const limit = intParam(q("limit"), "limit", 20, 1, 100) ?? 20;
		const offset = intParam(q("offset"), "offset", 0, 0, 1_000_000) ?? 0;
		const grade = intParam(q("grade"), "grade", null, 1, 12);
		const bloom = intParam(q("bloom_level"), "bloom_level", null, 1, 4);
		const type = oneOf(q("question_type"), "question_type", QUESTION_TYPES);
		const status = oneOf(q("status"), "status", ["draft", "approved", "retired"] as const);
		const loId = q("lo_id") ? parseUuid(q("lo_id")!, "lo_id") : null;
		const jobId = q("job_id") ? parseUuid(q("job_id")!, "job_id") : null;
		const rows = await c.get("db").select("questions", {
			select: LIST_SELECT,
			order: "created_at.desc,item_index.asc",
			offset,
			limit: limit + 1, // one extra row tells the client whether another page exists
			"question_los.learning_objectives.grade": grade ? `eq.${grade}` : undefined,
			"question_los.lo_id": loId ? `eq.${loId}` : undefined,
			question_type: type ? `eq.${type}` : undefined,
			status: status ? `eq.${status}` : undefined,
			bloom_level: bloom ? `eq.${bloom}` : undefined,
			job_id: jobId ? `eq.${jobId}` : undefined,
		});
		return c.json({
			items: rows.slice(0, limit).map(summarize),
			offset,
			limit,
			has_more: rows.length > limit,
		});
	});

	app.get("/v1/questions/:id", async (c) => {
		const id = parseUuid(c.req.param("id"), "question_id");
		const db = c.get("db");
		const q = await ownedQuestion(db, id);
		const [detailTable, childTable, order] = DETAILS[String(q.question_type)];
		q.detail = (await db.select(detailTable, { question_id: `eq.${id}` }))[0] ?? null;
		q.items = childTable
			? await db.select(childTable, { question_id: `eq.${id}`, order: order ?? undefined })
			: [];
		const media: Record<string, Row> = {};
		for (const row of [q.detail as Row | null, ...(q.items as Row[])]) {
			if (!row) continue;
			for (const [key, value] of Object.entries(row)) {
				if (
					!value ||
					typeof value !== "string" ||
					!/(image_id|audio_id)$/.test(key) ||
					media[value]
				)
					continue;
				const table = key.endsWith("image_id") ? "images" : "audios";
				const [record] = await db.select(table, { id: `eq.${value}` });
				if (record)
					media[value] = {
						...record,
						kind: table,
						url: await db.signedUrl(String(record.bucket), String(record.object_key)),
					};
			}
		}
		q.media = media;
		const links = await db.select("question_los", {
			select: `is_primary,learning_objectives(${LO_FIELDS})`,
			question_id: `eq.${id}`,
		});
		q.learning_objectives = links.map((l) => l.learning_objectives).filter(Boolean);
		return c.json(q); // Internal authoring endpoint: includes answers; not a learner API.
	});

	app.patch("/v1/questions/:id/review", async (c) => {
		const id = parseUuid(c.req.param("id"), "question_id");
		const body = z
			.strictObject({ status: z.enum(["approved", "retired"]) })
			.safeParse(await c.req.json().catch(() => null));
		if (!body.success) throw new HttpError(422, "status must be approved or retired");
		const db = c.get("db");
		await ownedQuestion(db, id);
		return c.json(await db.patch("questions", { status: body.data.status }, { id: `eq.${id}` }));
	});

	app.notFound((c) => c.json({ detail: "Not Found" }, 404));

	app.onError((error, c) => {
		if (error instanceof HttpError) return c.json({ detail: error.detail }, error.status as 400);
		if (error instanceof ConfigError)
			return c.json({ detail: `Backend configuration error: ${error.message}` }, 503);
		if (error instanceof DatabaseError)
			return c.json(
				{ detail: "Database operation failed. Verify migrations and backend configuration." },
				503,
			);
		console.error(
			"Unhandled error",
			error instanceof Error ? `${error.name}: ${error.message.slice(0, 200)}` : typeof error,
		);
		return c.json({ detail: "Internal error" }, 500);
	});

	return app;
}
