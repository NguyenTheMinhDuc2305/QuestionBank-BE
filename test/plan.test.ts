import { describe, expect, it } from "vite-plus/test";
import { buildRecords, planMedia, stableJson, uuid5 } from "../src/plan.ts";
import { DraftBatch, type QuestionDraft } from "../src/schemas.ts";

const el = (text: string, image = false, audio = true) => ({
	text,
	audio: audio ? { transcript: text, description: "Read clearly" } : null,
	image: image ? { prompt: text, negative_prompt: "text" } : null,
});
const JOB = "11111111-1111-4111-8111-111111111111";

const CASES: [Record<string, unknown>, string, number][] = [
	[
		{
			question_type: "COMP_SEL",
			stem: el("This is a ___.", true, false),
			options: ["pen", "book", "cat", "dog"].map((x) => ({ ...el(x), is_correct: x === "pen" })),
		},
		"completion_options",
		4,
	],
	[
		{
			question_type: "TYPING",
			stem: el("This is a ___.", true, false),
			answer: el("pen"),
			completed_sentence: "This is a pen.",
		},
		"typing_questions",
		1,
	],
	[
		{
			question_type: "MATCH",
			pairs: ["pen", "book"].map((x) => ({ left: el(x), right: el(x, true) })),
		},
		"matching_pairs",
		2,
	],
	[
		{
			question_type: "ORDER",
			tokens: [el("This"), el("is"), el("a pen.")],
			answer: el("This is a pen."),
		},
		"ordering_tokens",
		3,
	],
	[
		{ question_type: "LISTEN", items: [el("black cat", true), el("white dog", true)] },
		"listening_items",
		2,
	],
];

describe("uuid5", () => {
	it("matches Python uuid.uuid5", async () => {
		expect(await uuid5("00000000-0000-0000-0000-000000000000", "question:0")).toBe(
			"07ebb309-e4a6-5ddd-b031-949b17d91166",
		);
		expect(await uuid5("6ba7b811-9dad-11d1-80b4-00c04fd430c8", "questionbank:lo:1|1|x")).toBe(
			"45bffd33-9c1c-5eeb-b8f7-e85b5af53944",
		);
	});

	it("stableJson sorts keys", () => {
		expect(stableJson({ b: 1, a: [{ d: 1, c: 2 }] })).toBe('{"a":[{"c":2,"d":1}],"b":1}');
	});
});

describe("records per question type", () => {
	for (const [raw, child, count] of CASES)
		it(`${String(raw.question_type as string)} links individual media`, async () => {
			const batch = DraftBatch.parse({ questions: [raw] });
			const media = await planMedia(JOB, batch);
			const records = await buildRecords(JOB, "q1", batch.questions[0] as QuestionDraft);
			expect(records.filter((r) => r.table === child)).toHaveLength(count);
			expect(records.every((r) => r.row.question_id === "q1")).toBe(true);
			const ids = new Set(media.map((m) => m.id));
			const referenced = records.flatMap((r) =>
				Object.entries(r.row)
					.filter(([k, v]) => /(image_id|audio_id)$/.test(k) && v)
					.map(([, v]) => v as string),
			);
			expect(referenced.length).toBeGreaterThan(0);
			expect(referenced.every((id) => ids.has(id))).toBe(true);
		});

	it("reuses one media file for identical specs and keeps distinct ones separate", async () => {
		// MATCH: left "pen" audio and right "pen" audio are the same spec → one file; images are separate.
		const batch = DraftBatch.parse({ questions: [CASES[2][0]] });
		const media = await planMedia(JOB, batch);
		expect(media.filter((m) => m.kind === "audio")).toHaveLength(2); // "pen", "book"
		expect(media.filter((m) => m.kind === "image")).toHaveLength(2);
		const again = await planMedia(JOB, batch);
		expect(again.map((m) => m.id)).toEqual(media.map((m) => m.id)); // deterministic across replays
	});
});
