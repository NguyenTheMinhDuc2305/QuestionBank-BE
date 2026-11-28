import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { bytesToBase64 } from "../src/providers.ts";
import { BUDGET, GenerateJobWorkflow } from "../src/workflow.ts";
import { ENV } from "./helpers.ts";

const JOB = "33333333-3333-4333-8333-333333333333";
const LO = "22222222-2222-4222-8222-222222222222";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9]);
const SETTINGS = {
	...ENV,
	OPENROUTER_API_KEY: "or-key",
	OPENROUTER_TEXT_MODEL: "text-model",
	IMG_GEN_API_KEY: "img-key",
};
const CONFIG = {
	lo_id: LO,
	question_type: "LISTEN",
	bloom_level: 1,
	count: 1,
	include_images: true,
	include_audio: true,
	instructions: "",
};
const item = (text: string) => ({
	text,
	image: { prompt: `a ${text}`, negative_prompt: "text" },
	audio: { transcript: text, description: "slow" },
});
const DRAFT = { questions: [{ question_type: "LISTEN", items: [item("cat"), item("dog")] }] };
type Saved = { p_worker: string; p_records: { table: string; row: Record<string, unknown> }[] };

/** Fake WorkflowStep: runs callbacks inline and records step names. */
function fakeStep() {
	const names: string[] = [];
	return {
		names,
		step: {
			do: async (name: string, a: unknown, b?: unknown) => {
				names.push(name);
				const fn = (typeof a === "function" ? a : b) as () => Promise<unknown>;
				// Mimic persistence: results must survive structured cloning.
				return structuredClone(await fn());
			},
			sleep: async (name: string) => {
				names.push(name);
			},
		},
	};
}

/** Mock Supabase, OpenRouter and tguru; counts external subrequests. */
function mockServices(opts: { imageFails?: boolean; draft?: unknown } = {}) {
	const counter = { external: 0 };
	const patches: Record<string, unknown>[] = [];
	const saved: Saved[] = [];
	const uploads: string[] = [];
	const inserts: string[] = [];
	let checkpoint: unknown = null;
	let polls = 0;
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		counter.external++;
		const req = new Request(input as RequestInfo, init);
		const url = new URL(req.url);
		const path = url.pathname;
		if (url.host === "test.supabase.co") {
			if (path === "/rest/v1/generation_jobs" && req.method === "GET")
				return Response.json([{ config: CONFIG, status: "running", checkpoint }]);
			if (path === "/rest/v1/generation_jobs" && req.method === "PATCH") {
				const body = (await req.json()) as Record<string, unknown>;
				if (body.checkpoint) checkpoint = body.checkpoint;
				patches.push(body);
				return Response.json([{ id: JOB }]);
			}
			if (path === "/rest/v1/learning_objectives")
				return Response.json([{ id: LO, content: "animals" }]);
			if ((path === "/rest/v1/images" || path === "/rest/v1/audios") && req.method === "GET")
				return Response.json([]);
			if ((path === "/rest/v1/images" || path === "/rest/v1/audios") && req.method === "POST") {
				inserts.push(path);
				return new Response(null, { status: 201 });
			}
			if (path.startsWith("/storage/v1/object/")) {
				expect(req.headers.get("x-upsert")).toBe("true");
				uploads.push(path);
				return Response.json({ Key: path });
			}
			if (path === "/rest/v1/rpc/save_generated_question") {
				saved.push((await req.json()) as Saved);
				return Response.json("ok");
			}
		}
		if (url.host === "openrouter.ai") {
			const body = (await req.json()) as { stream?: boolean };
			if (body.stream)
				return new Response(
					`data: ${JSON.stringify({ choices: [{ delta: { audio: { data: bytesToBase64(new Uint8Array([1, 0, 2, 0])) } } }] })}\n\ndata: [DONE]\n\n`,
				);
			return Response.json({
				choices: [{ message: { content: JSON.stringify(opts.draft ?? DRAFT) } }],
			});
		}
		if (url.host === "genimg.tguru.vn:8000") {
			if (req.method === "POST") return Response.json({ job_id: `p-${crypto.randomUUID()}` });
			if (path.startsWith("/v1/jobs/")) {
				polls++;
				if (opts.imageFails) return Response.json({ status: "failed" });
				return Response.json(
					polls % 2
						? { status: "running" }
						: { status: "succeeded", image_url: "/v1/images/x.png" },
				);
			}
			if (path.startsWith("/v1/images/")) return new Response(PNG);
		}
		return new Response(`unexpected ${req.method} ${url.href}`, { status: 500 });
	});
	return { patches, saved, uploads, inserts, counter };
}

/** Instance without the runtime constructor (it requires a real Workflow context). */
function workflow(created: { id: string; params: unknown }[] = []): GenerateJobWorkflow {
	const wf = Object.create(GenerateJobWorkflow.prototype) as GenerateJobWorkflow;
	const GENERATE_JOB = {
		create: async (opts: { id: string; params: unknown }) => {
			created.push(opts);
			return { id: opts.id };
		},
	};
	Object.defineProperty(wf, "env", { value: { ...env, ...SETTINGS, GENERATE_JOB } });
	return wf;
}

afterEach(() => vi.restoreAllMocks());

describe("GenerateJobWorkflow", () => {
	it("generates draft, media (images + per-item audio) and saves the question atomically", async () => {
		const svc = mockServices();
		const { step, names } = fakeStep();
		const result = await workflow().run({ payload: { jobId: JOB } } as never, step as never);
		expect(result).toEqual({ questions: 1 });
		expect(svc.patches.map((p) => p.status).filter(Boolean)).toEqual(["running", "completed"]);
		expect(svc.patches.some((p) => p.checkpoint)).toBe(true);
		expect(svc.uploads).toHaveLength(4); // 2 images + 2 audios
		expect(svc.inserts.filter((p) => p.endsWith("images"))).toHaveLength(2);
		expect(svc.saved).toHaveLength(1);
		const items = svc.saved[0].p_records.filter((r) => r.table === "listening_items");
		expect(items).toHaveLength(2);
		expect(items.every((r) => r.row.image_id && r.row.audio_id)).toBe(true);
		expect(svc.saved[0].p_worker).toBe(JOB);
		// Each poll is preceded by a sleep; every billed call is a separate step.
		expect(names).toContain("generate draft");
		expect(names.filter((n) => n.startsWith("image 0 wait"))).toHaveLength(2);
		expect(svc.counter.external).toBeLessThanOrEqual(BUDGET);
	});

	it("marks the job failed with a safe message when the image provider fails", async () => {
		const svc = mockServices({ imageFails: true });
		const { step, names } = fakeStep();
		await expect(
			workflow().run({ payload: { jobId: JOB } } as never, step as never),
		).rejects.toThrow(/Image generation failed/);
		const failed = svc.patches.find((p) => p.status === "failed");
		expect(String(failed?.error)).toMatch(/^ProviderError: Image generation failed/);
		expect(String(failed?.error)).not.toContain("img-key");
		expect(names.at(-1)).toBe("mark failed");
		expect(svc.saved).toHaveLength(0);
	});

	it("splits a large job into a chain of instances, each within the free-plan subrequest budget", async () => {
		const words = ["cat", "dog", "bird", "fish", "frog", "duck", "cow", "pig"];
		const svc = mockServices({
			draft: { questions: [{ question_type: "LISTEN", items: words.map(item) }] },
		});
		const perInstance: number[] = [];
		const ids: string[] = [];
		let params: Record<string, unknown> = { jobId: JOB };
		let result: unknown;
		for (let i = 0; i < 20; i++) {
			const created: { id: string; params: unknown }[] = [];
			svc.counter.external = 0;
			result = await workflow(created).run({ payload: params } as never, fakeStep().step as never);
			perInstance.push(svc.counter.external);
			if (!created.length) break;
			expect(created).toHaveLength(1);
			ids.push(created[0].id);
			params = created[0].params as Record<string, unknown>;
		}
		expect(result).toEqual({ questions: 1 });
		expect(perInstance.length).toBeGreaterThan(2); // 16 media files cannot fit in one instance
		expect(Math.max(...perInstance)).toBeLessThanOrEqual(BUDGET);
		expect(ids).toEqual(ids.map((_, i) => `${JOB}-${i + 1}`));
		expect(svc.uploads).toHaveLength(16);
		const items = svc.saved[0].p_records.filter((r) => r.table === "listening_items");
		expect(items).toHaveLength(8);
		expect(items.every((r) => r.row.image_id && r.row.audio_id)).toBe(true);
		expect(svc.patches.filter((p) => p.status === "completed")).toHaveLength(1);
	});

	it("resumes image polling in the next instance with the saved provider job", async () => {
		const svc = mockServices();
		await workflow().run({ payload: { jobId: JOB } } as never, fakeStep().step as never); // creates the checkpoint
		svc.counter.external = 0;
		const { step, names } = fakeStep();
		const r = await workflow().run(
			{
				payload: { jobId: JOB, seq: 3, cursor: { unit: 0, providerJob: "p-saved", polls: 5 } },
			} as never,
			step as never,
		);
		expect(r).toEqual({ questions: 1 });
		expect(names[0]).toBe("load state");
		expect(names).not.toContain("image 0 submit");
		expect(names).toContain("image 0 poll 5");
		expect(svc.counter.external).toBeLessThanOrEqual(BUDGET);
	});
});
