import { describe, expect, it } from "vite-plus/test";
import {
	Completion,
	DraftBatch,
	GenerationRequest,
	Listening,
	Ordering,
	Typing,
	jobConfig,
	validateBatch,
} from "../src/schemas.ts";
import { completion } from "./helpers.ts";

const request = (extra: Record<string, unknown> = {}) =>
	jobConfig(
		GenerationRequest.parse({
			request_key: crypto.randomUUID(),
			lo_id: crypto.randomUUID(),
			question_type: "COMP_SEL",
			bloom_level: 1,
			...extra,
		}),
	);

describe("question schemas", () => {
	it("accepts a valid completion and fills defaults", () => {
		const q = Completion.parse(completion());
		expect(q.hint).toBe("");
		expect(q.stem.image).toBeNull();
	});

	it("requires exactly one correct option", () => {
		const raw = completion();
		(raw.options as { is_correct: boolean }[])[1].is_correct = true;
		expect(Completion.safeParse(raw).success).toBe(false);
	});

	it("rejects unknown fields (strict)", () => {
		expect(Completion.safeParse({ ...completion(), extra: 1 }).success).toBe(false);
	});

	it("checks typing answer consistency", () => {
		const raw = { question_type: "TYPING", stem: { text: "A ___." }, answer: { text: "pen" } };
		expect(Typing.safeParse({ ...raw, completed_sentence: "A cat." }).success).toBe(false);
		expect(Typing.safeParse({ ...raw, completed_sentence: "A pen." }).success).toBe(true);
	});

	it("requires individual image and audio per listening item", () => {
		expect(
			Listening.safeParse({ question_type: "LISTEN", items: [{ text: "cat" }, { text: "dog" }] })
				.success,
		).toBe(false);
	});

	it("limits ordering to ten words, not just ten chunks", () => {
		const r = Ordering.safeParse({
			question_type: "ORDER",
			tokens: [{ text: "one two three four five six" }, { text: "seven eight nine ten eleven" }],
			answer: { text: "one two three four five six seven eight nine ten eleven" },
		});
		expect(r.success).toBe(false);
	});

	it("validates generation request media rules", () => {
		const base = { request_key: crypto.randomUUID(), lo_id: crypto.randomUUID(), bloom_level: 1 };
		expect(GenerationRequest.safeParse({ ...base, question_type: "LISTEN" }).success).toBe(false);
		expect(
			GenerationRequest.safeParse({ ...base, question_type: "ORDER", include_images: true })
				.success,
		).toBe(false);
		expect(
			GenerationRequest.safeParse({ ...base, question_type: "MATCH", bloom_level: 5 }).success,
		).toBe(false);
	});
});

describe("batch validation", () => {
	it("requires audio on every option when audio is enabled", () => {
		const batch = DraftBatch.parse({ questions: [completion()] });
		expect(() => validateBatch(batch, request({ include_audio: true }))).toThrow(/separate audio/);
	});

	it("rejects unrequested images", () => {
		const raw = completion();
		(raw.stem as Record<string, unknown>).image = { prompt: "pen" };
		expect(() => validateBatch(DraftBatch.parse({ questions: [raw] }), request())).toThrow(
			/Unrequested image/,
		);
	});

	it("rejects count and type mismatch and exact duplicates", () => {
		const batch = DraftBatch.parse({ questions: [completion(), completion()] });
		expect(() => validateBatch(batch, request())).toThrow(/count/);
		expect(() => validateBatch(batch, request({ count: 2 }))).toThrow(/duplicate/);
		expect(() =>
			validateBatch(
				DraftBatch.parse({ questions: [completion()] }),
				request({ question_type: "MATCH" }),
			),
		).toThrow(/type/);
	});
});
