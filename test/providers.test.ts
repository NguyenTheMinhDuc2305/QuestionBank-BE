import { describe, expect, it } from "vite-plus/test";
import {
	ProviderError,
	Providers,
	TTS_INSTRUCTION,
	bytesToBase64,
	effectiveImagePrompt,
	pcm16ToWav,
	sniffImage,
} from "../src/providers.ts";
import { GenerationRequest, jobConfig } from "../src/schemas.ts";
import { generationErrors, loadSettings } from "../src/settings.ts";
import { ENV, completion, mockFetch, settings } from "./helpers.ts";

const sse = (events: unknown[], done = true) =>
	new Response(
		events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + (done ? "data: [DONE]\n\n" : ""),
	);
const audioEvent = (bytes: Uint8Array) => ({
	choices: [{ delta: { audio: { data: bytesToBase64(bytes) } } }],
});

describe("settings", () => {
	it("rejects the Supabase dashboard URL", () => {
		expect(() =>
			loadSettings({ ...ENV, SUPABASE_URL: "https://supabase.com/dashboard/project/x" }),
		).toThrow(/project API URL/);
	});
	it("has no default text model; audio defaults match the previous POC", () => {
		const s = settings();
		const missing = generationErrors(s, { images: true, audio: true });
		expect(missing).toEqual(
			expect.arrayContaining(["OPENROUTER_API_KEY", "OPENROUTER_TEXT_MODEL", "IMG_GEN_API_KEY"]),
		);
		expect(missing).not.toContain("OPENROUTER_AUDIO_MODEL");
		expect([
			s.openrouterAudioModel,
			s.openrouterAudioFallbackModel,
			s.openrouterAudioVoice,
		]).toEqual(["openai/gpt-audio-mini", "openai/gpt-audio", "nova"]);
	});

	it("parses JSON or comma CORS lists", () => {
		expect(settings({ CORS_ORIGINS: "https://a.test, https://b.test" }).corsOrigins).toEqual([
			"https://a.test",
			"https://b.test",
		]);
	});
});

describe("images (tguru)", () => {
	it("appends the negative prompt", () => {
		expect(effectiveImagePrompt({ prompt: "a cat", negative_prompt: "text" })).toBe(
			"a cat\n\nAvoid: text",
		);
	});

	it("submits with idempotency key, polls and downloads same-origin with the model name", async () => {
		const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);
		const { fn, seen } = mockFetch(async (req) => {
			const url = new URL(req.url);
			if (req.method === "POST") {
				const body = (await req.json()) as Record<string, unknown>;
				expect(Object.keys(body).sort()).toEqual(["idempotency_key", "prompt"]);
				expect(body.prompt).toContain("Avoid: text");
				return Response.json({ job_id: "job1" });
			}
			if (url.pathname === "/v1/jobs/job1")
				return Response.json({
					status: "succeeded",
					image_url: "/v1/images/a.png",
					params: { model: "qwen-image" },
				});
			return new Response(png);
		});
		const p = new Providers(settings({ IMG_GEN_API_KEY: "k" }), fn);
		expect(await p.imageSubmit({ prompt: "cat", negative_prompt: "text" }, "key")).toBe("job1");
		const poll = await p.imagePoll("job1");
		expect(poll).toEqual({
			state: "ready",
			url: "https://genimg.tguru.vn:8000/v1/images/a.png",
			model: "tguru:qwen-image",
		});
		const img = await p.imageDownload(poll.state === "ready" ? poll.url : "");
		expect(img.mime).toBe("image/png");
		expect(seen.every((r) => r.headers.get("X-API-Key") === "k")).toBe(true);
	});

	it("refuses to send the key to another host", async () => {
		const { fn } = mockFetch(() =>
			Response.json({ status: "succeeded", image_url: "https://evil.test/v1/images/x.png" }),
		);
		await expect(new Providers(settings(), fn).imagePoll("job1")).rejects.toThrow(/outside/);
	});

	it("reports pending and failed states", async () => {
		let status = "running";
		const { fn } = mockFetch(() => Response.json({ status }));
		const p = new Providers(settings(), fn);
		expect(await p.imagePoll("j")).toEqual({ state: "pending" });
		status = "failed";
		expect(await p.imagePoll("j")).toEqual({ state: "failed" });
	});

	it("sniffs image types", () => {
		expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0]))).toBe("image/jpeg");
		expect(sniffImage(new TextEncoder().encode("RIFF0000WEBPxx"))).toBe("image/webp");
		expect(sniffImage(new TextEncoder().encode("<html>"))).toBeNull();
	});
});

describe("audio (OpenRouter chat, pcm16)", () => {
	it("requests pcm16, decodes each chunk and wraps a 24 kHz WAV", async () => {
		const parts = [new Uint8Array([1, 0, 2, 0]), new Uint8Array([3, 0])];
		const { fn } = mockFetch(async (req) => {
			expect(req.headers.get("Authorization")).toBe("Bearer test");
			const body = (await req.json()) as { stream: boolean; audio: { format: string } };
			expect(body.stream).toBe(true);
			expect(body.audio.format).toBe("pcm16");
			return sse(parts.map(audioEvent));
		});
		const p = new Providers(settings({ OPENROUTER_API_KEY: "test" }), fn);
		const { data, mime } = await p.audio({ transcript: "hello", description: "slow" });
		expect(mime).toBe("audio/wav");
		expect([...data]).toEqual([...pcm16ToWav(new Uint8Array([1, 0, 2, 0, 3, 0]), 24000)]);
		expect(new TextDecoder().decode(data.subarray(0, 4))).toBe("RIFF");
		expect(new DataView(data.buffer).getUint32(24, true)).toBe(24000);
	});

	it("sends only the fixed TTS instruction + transcript (no per-asset description)", async () => {
		const { fn, seen } = mockFetch(() => sse([audioEvent(new Uint8Array([1, 0]))]));
		await new Providers(settings({ OPENROUTER_API_KEY: "t" }), fn).audio({
			transcript: "cat",
			description: "excited",
		});
		const body = (await seen[0].json()) as {
			model: string;
			audio: { voice: string };
			messages: { role: string; content: string }[];
		};
		expect(body.model).toBe("openai/gpt-audio-mini");
		expect(body.audio.voice).toBe("nova");
		expect(body.messages).toEqual([
			{ role: "system", content: TTS_INSTRUCTION },
			{ role: "user", content: "cat" },
		]);
		expect(TTS_INSTRUCTION).toContain("Vietnamese Grade 1 children");
	});

	it("is lenient like the previous POC: no [DONE] needed, broken lines ignored", async () => {
		const { fn } = mockFetch(
			() =>
				new Response(`: OPENROUTER PROCESSING

data: {broken

data: ${JSON.stringify(audioEvent(new Uint8Array([5, 0, 6])))}

`),
		);
		const r = await new Providers(settings({ OPENROUTER_API_KEY: "t" }), fn).audio({
			transcript: "hi",
			description: "",
		});
		expect([...r.data.subarray(44)]).toEqual([5, 0]); // odd trailing byte dropped
	});

	it("fails when no audio arrives, after trying the fallback model", async () => {
		const { fn, seen } = mockFetch(() => sse([{ choices: [{ delta: { content: "text only" } }] }]));
		await expect(
			new Providers(settings({ OPENROUTER_API_KEY: "t" }), fn).audio({
				transcript: "hi",
				description: "",
			}),
		).rejects.toThrow(/No audio returned/);
		const models = await Promise.all(
			seen.map(async (r) => ((await r.json()) as { model: string }).model),
		);
		expect(models).toEqual(["openai/gpt-audio-mini", "openai/gpt-audio"]);
	});

	it("uses the fallback model when the default model is rejected, and reports which model", async () => {
		const { fn } = mockFetch(async (req) =>
			((await req.json()) as { model: string }).model === "openai/gpt-audio-mini"
				? new Response("bad", { status: 400 })
				: sse([audioEvent(new Uint8Array([1, 0]))]),
		);
		const r = await new Providers(settings({ OPENROUTER_API_KEY: "t" }), fn).audio({
			transcript: "hi",
			description: "",
		});
		expect(r.model).toBe("openai/gpt-audio");
	});

	it("does not try the fallback on 401/402/403/503", async () => {
		const { fn, seen } = mockFetch(() => new Response("no", { status: 402 }));
		await expect(
			new Providers(settings({ OPENROUTER_API_KEY: "t" }), fn).audio({
				transcript: "hi",
				description: "",
			}),
		).rejects.toThrow(/402/);
		expect(seen).toHaveLength(1);
	});

	it("retries once on 429/5xx before giving up on a model", async () => {
		let calls = 0;
		const { fn } = mockFetch(() =>
			++calls === 1
				? new Response("busy", { status: 500 })
				: sse([audioEvent(new Uint8Array([1, 0]))]),
		);
		const r = await new Providers(settings({ OPENROUTER_API_KEY: "t" }), fn).audio({
			transcript: "hi",
			description: "",
		});
		expect(calls).toBe(2);
		expect(r.model).toBe("openai/gpt-audio-mini");
	});

	it("surfaces provider HTTP errors without the body", async () => {
		const { fn } = mockFetch(() => new Response("secret upstream detail", { status: 400 }));
		const error = await new Providers(settings(), fn)
			.audio({ transcript: "hi", description: "" })
			.catch((e) => e);
		expect(error).toBeInstanceOf(ProviderError);
		expect(String(error.message)).not.toContain("secret");
	});
});

describe("text drafts", () => {
	const config = jobConfig(
		GenerationRequest.parse({
			request_key: crypto.randomUUID(),
			lo_id: crypto.randomUUID(),
			question_type: "COMP_SEL",
			bloom_level: 1,
		}),
	);
	const reply = (content: string) => () => Response.json({ choices: [{ message: { content } }] });

	it("parses and validates the model JSON (also inside a code fence)", async () => {
		const { fn, seen } = mockFetch(
			reply("```json\n" + JSON.stringify({ questions: [completion()] }) + "\n```"),
		);
		const batch = await new Providers(
			settings({ OPENROUTER_API_KEY: "t", OPENROUTER_TEXT_MODEL: "m" }),
			fn,
		).content(config, { content: "pen" });
		expect(batch.questions).toHaveLength(1);
		const sent = (await seen[0].json()) as {
			messages: { content: string }[];
			response_format: unknown;
		};
		expect(JSON.parse(sent.messages[1].content).json_schema).toBeTruthy();
	});

	it("fails safely on invalid model output", async () => {
		const bad = completion();
		(bad.options as unknown[]).pop();
		const { fn } = mockFetch(reply(JSON.stringify({ questions: [bad] })));
		await expect(new Providers(settings(), fn).content(config, {})).rejects.toThrow(
			/failed validation/,
		);
	});
});
