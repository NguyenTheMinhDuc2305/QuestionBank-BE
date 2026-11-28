import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { POC_OWNER_ID, createApp } from "../src/api.ts";
import { ENV } from "./helpers.ts";

type Handler = (url: URL, req: Request) => Response | Promise<Response>;

function setup(handler: Handler, extraEnv: Record<string, string> = {}) {
	const calls: URL[] = [];
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const req = new Request(input as RequestInfo, init);
		const url = new URL(req.url);
		calls.push(url);
		return handler(url, req);
	});
	const created: unknown[] = [];
	const env = {
		...ENV,
		...extraEnv,
		GENERATE_JOB: { create: async (opts: unknown) => (created.push(opts), { id: "x" }) },
	} as unknown as Env;
	const app = createApp();
	const call = (path: string, init?: RequestInit) =>
		app.fetch(new Request(`https://worker.test${path}`, init), env);
	return { call, calls, created };
}

afterEach(() => vi.restoreAllMocks());

const PROVIDERS = { OPENROUTER_API_KEY: "k", OPENROUTER_TEXT_MODEL: "m" };
const LO = "22222222-2222-4222-8222-222222222222";
const jobBody = (extra: Record<string, unknown> = {}) =>
	JSON.stringify({
		request_key: crypto.randomUUID(),
		lo_id: LO,
		question_type: "COMP_SEL",
		bloom_level: 1,
		...extra,
	});

describe("API", () => {
	it("serves health, config and CORS for the allowed origin only", async () => {
		const { call } = setup(() => Response.json([]));
		expect((await call("/health")).status).toBe(200);
		const config = await (await call("/v1/config")).json<Record<string, string[]>>();
		expect(config.missing_text_settings).toContain("OPENROUTER_TEXT_MODEL");
		const ok = await call("/health", { headers: { Origin: "http://localhost:3000" } });
		expect(ok.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:3000");
		const other = await call("/health", { headers: { Origin: "https://evil.test" } });
		expect(other.headers.get("Access-Control-Allow-Origin")).toBeNull();
	});

	it("validates job requests and reports missing provider settings", async () => {
		const { call } = setup(() => Response.json([]));
		expect((await call("/v1/jobs", { method: "POST", body: "{}" })).status).toBe(422);
		const r = await call("/v1/jobs", { method: "POST", body: jobBody() });
		expect(r.status).toBe(503);
		expect(
			((await r.json()) as { detail: { missing_settings: string[] } }).detail.missing_settings,
		).toContain("OPENROUTER_API_KEY");
	});

	it("enqueues a job atomically and starts its Workflow with the job id", async () => {
		const { call, created, calls } = setup((url) => {
			if (url.pathname.endsWith("/learning_objectives")) return Response.json([{ id: LO }]);
			if (url.pathname.endsWith("/generation_jobs")) return Response.json([]);
			if (url.pathname.endsWith("/rpc/enqueue_generation_job"))
				return Response.json({ id: "job-1", status: "queued" });
			return new Response("unexpected", { status: 500 });
		}, PROVIDERS);
		const r = await call("/v1/jobs", { method: "POST", body: jobBody() });
		expect(r.status).toBe(202);
		expect(created).toEqual([{ id: "job-1", params: { jobId: "job-1" } }]);
		const lookup = calls.find((u) => u.pathname.endsWith("/generation_jobs"));
		expect(lookup?.searchParams.get("owner_id")).toBe(`eq.${POC_OWNER_ID}`);
	});

	it("returns the existing job for a repeated request key and rejects a changed config", async () => {
		const key = crypto.randomUUID();
		const config = {
			lo_id: LO,
			question_type: "COMP_SEL",
			bloom_level: 1,
			count: 1,
			include_images: false,
			include_audio: false,
			instructions: "",
		};
		const { call, created } = setup((url) => {
			if (url.pathname.endsWith("/learning_objectives")) return Response.json([{ id: LO }]);
			if (url.pathname.endsWith("/generation_jobs")) return Response.json([{ id: "old", config }]);
			return new Response("unexpected", { status: 500 });
		}, PROVIDERS);
		const same = await call("/v1/jobs", { method: "POST", body: jobBody({ request_key: key }) });
		expect(same.status).toBe(202);
		expect(((await same.json()) as { id: string }).id).toBe("old");
		const changed = await call("/v1/jobs", {
			method: "POST",
			body: jobBody({ request_key: key, count: 2 }),
		});
		expect(changed.status).toBe(409);
		expect(created).toHaveLength(0);
	});

	it("lists generated questions with filters, summary and paging", async () => {
		const row = (id: string) => ({
			id,
			question_type: "MATCH",
			bloom_level: 2,
			status: "draft",
			instruction_text: "Match",
			created_at: "2026-01-01T00:00:00Z",
			job_id: "j",
			item_index: 0,
			question_los: [{ lo_id: LO, learning_objectives: { code: "LO1", grade: 1 } }],
			matching_questions: {
				matching_pairs: [
					{ left_text: "dog", right_text: "chó", position: 1 },
					{ left_text: "cat", right_text: "mèo", position: 0 },
				],
			},
		});
		const { call, calls } = setup(() => Response.json([row("a"), row("b")]));
		const r = await call("/v1/questions?grade=1&status=draft&question_type=MATCH&limit=1");
		const body = (await r.json()) as {
			items: { summary: string; lo: { code: string } }[];
			has_more: boolean;
		};
		expect(body.has_more).toBe(true);
		expect(body.items).toHaveLength(1);
		expect(body.items[0].summary).toBe("cat ↔ mèo · dog ↔ chó");
		expect(body.items[0].lo.code).toBe("LO1");
		const q = calls[0].searchParams;
		expect(q.get("question_los.learning_objectives.grade")).toBe("eq.1");
		expect(q.get("limit")).toBe("2");
		expect((await call("/v1/questions?status=bogus")).status).toBe(422);
		expect((await call("/v1/questions/not-a-uuid")).status).toBe(422);
	});

	it("hides database details on failure", async () => {
		const { call } = setup(
			() => new Response("relation does not exist; key=sb_secret", { status: 500 }),
		);
		const r = await call("/v1/jobs");
		expect(r.status).toBe(503);
		expect(await r.text()).not.toContain("sb_secret");
	});
});
