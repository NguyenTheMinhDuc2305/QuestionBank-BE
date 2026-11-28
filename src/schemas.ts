// Strict validation of AI drafts and generation requests (port of the Python Pydantic models).
import { z } from "zod";

const text = (min: number, max: number) => z.string().trim().min(min).max(max);
const optText = (max: number, fallback = "") => z.string().trim().max(max).default(fallback);
const lower = (value: string) => value.toLocaleLowerCase();

export const ImageSpec = z.strictObject({
	prompt: text(1, 1600),
	negative_prompt: optText(350),
});
export type ImageSpec = z.infer<typeof ImageSpec>;

export const AudioSpec = z.strictObject({
	transcript: text(1, 1000),
	description: optText(500, "Clear, natural English pronunciation."),
});
export type AudioSpec = z.infer<typeof AudioSpec>;

const elementShape = {
	text: text(1, 2000),
	image: ImageSpec.nullable().default(null),
	audio: AudioSpec.nullable().default(null),
};
export const Element = z.strictObject(elementShape);
export type Element = z.infer<typeof Element>;

const Option = z.strictObject({ ...elementShape, is_correct: z.boolean() });
const Pair = z.strictObject({ left: Element, right: Element });

const base = {
	instruction_text: optText(1000),
	hint: optText(2000),
	explanation: optText(4000),
};

const blankCount = (value: string) => value.split("___").length - 1;

export const Completion = z
	.strictObject({
		...base,
		question_type: z.literal("COMP_SEL"),
		stem: Element,
		options: z.array(Option).min(4).max(8),
	})
	.superRefine((q, ctx) => {
		if (blankCount(q.stem.text) !== 1)
			ctx.addIssue({ code: "custom", message: "Stem must contain exactly one ___ blank" });
		if (q.options.filter((o) => o.is_correct).length !== 1)
			ctx.addIssue({ code: "custom", message: "Exactly one correct option required" });
		if (new Set(q.options.map((o) => lower(o.text))).size !== q.options.length)
			ctx.addIssue({ code: "custom", message: "Duplicate options" });
	});

export const Typing = z
	.strictObject({
		...base,
		question_type: z.literal("TYPING"),
		stem: Element,
		answer: Element,
		completed_sentence: text(1, 2000),
		case_sensitive: z.boolean().default(false),
	})
	.superRefine((q, ctx) => {
		if (blankCount(q.stem.text) !== 1)
			ctx.addIssue({ code: "custom", message: "Stem must contain exactly one ___ blank" });
		else if (q.stem.text.replace("___", q.answer.text) !== q.completed_sentence)
			ctx.addIssue({
				code: "custom",
				message: "Completed sentence does not match the blank answer",
			});
		if (q.answer.image)
			ctx.addIssue({ code: "custom", message: "Typing answer is text, not an image" });
	});

export const Matching = z
	.strictObject({
		...base,
		question_type: z.literal("MATCH"),
		pairs: z.array(Pair).min(2).max(8),
	})
	.superRefine((q, ctx) => {
		for (const side of ["left", "right"] as const) {
			const values = q.pairs.map((p) => lower(p[side].text));
			if (new Set(values).size !== values.length)
				ctx.addIssue({ code: "custom", message: "Matching sides must be distinct" });
		}
	});

export const Ordering = z
	.strictObject({
		...base,
		question_type: z.literal("ORDER"),
		tokens: z.array(Element).min(2).max(10),
		answer: Element,
	})
	.superRefine((q, ctx) => {
		if (q.tokens.map((t) => t.text).join(" ") !== q.answer.text)
			ctx.addIssue({ code: "custom", message: "Ordered tokens must join exactly to the answer" });
		if (q.answer.text.split(/\s+/).filter(Boolean).length > 10)
			ctx.addIssue({ code: "custom", message: "Ordering supports at most 10 words" });
		if (q.tokens.some((t) => t.image) || q.answer.image)
			ctx.addIssue({ code: "custom", message: "Ordering uses text chunks" });
	});

export const Listening = z
	.strictObject({
		...base,
		question_type: z.literal("LISTEN"),
		items: z.array(Element).min(2).max(8),
	})
	.superRefine((q, ctx) => {
		if (q.items.some((i) => !i.image || !i.audio))
			ctx.addIssue({
				code: "custom",
				message: "Every listening item requires its own image and audio",
			});
		if (new Set(q.items.map((i) => lower(i.text))).size !== q.items.length)
			ctx.addIssue({ code: "custom", message: "Listening images must be distinguishable" });
	});

export const QuestionDraft = z.discriminatedUnion("question_type", [
	Completion,
	Typing,
	Matching,
	Ordering,
	Listening,
]);
export type QuestionDraft = z.infer<typeof QuestionDraft>;

export const DraftBatch = z.strictObject({ questions: z.array(QuestionDraft).min(1).max(10) });
export type DraftBatch = z.infer<typeof DraftBatch>;

export const QUESTION_TYPES = ["COMP_SEL", "TYPING", "MATCH", "ORDER", "LISTEN"] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

export const GenerationRequest = z
	.strictObject({
		request_key: z.uuid(),
		lo_id: z.uuid(),
		question_type: z.enum(QUESTION_TYPES),
		bloom_level: z.int().min(1).max(4),
		count: z.int().min(1).max(10).default(1),
		include_images: z.boolean().default(false),
		include_audio: z.boolean().default(false),
		instructions: optText(2000),
	})
	.superRefine((r, ctx) => {
		if (r.question_type === "LISTEN" && !(r.include_audio && r.include_images))
			ctx.addIssue({
				code: "custom",
				message: "LISTEN requires both images and separate audio clips",
			});
		if (r.question_type === "ORDER" && r.include_images)
			ctx.addIssue({ code: "custom", message: "ORDER is text/audio only in this POC" });
	});
export type GenerationRequest = z.infer<typeof GenerationRequest>;
/** Stored job config: the request without its idempotency key (same shape as the Python backend). */
export type JobConfig = Omit<GenerationRequest, "request_key">;

export function jobConfig(r: GenerationRequest): JobConfig {
	const { request_key: _key, ...config } = r;
	return config;
}

/** Every element that may carry media, in a stable order. */
export function elements(q: QuestionDraft): Element[] {
	switch (q.question_type) {
		case "COMP_SEL":
			return [q.stem, ...q.options];
		case "TYPING":
			return [q.stem, q.answer];
		case "MATCH":
			return q.pairs.flatMap((p) => [p.left, p.right]);
		case "ORDER":
			return [...q.tokens, q.answer];
		case "LISTEN":
			return [...q.items];
	}
}

function answerElements(q: QuestionDraft): Element[] {
	switch (q.question_type) {
		case "COMP_SEL":
			return [...q.options];
		case "TYPING":
			return [q.answer];
		default:
			return elements(q);
	}
}

export function validateBatch(batch: DraftBatch, request: JobConfig): void {
	if (batch.questions.length !== request.count)
		throw new Error("Generated question count differs from request");
	const seen = new Set<string>();
	for (const q of batch.questions) {
		if (q.question_type !== request.question_type)
			throw new Error("Generated question type differs from request");
		const fingerprint = JSON.stringify(q);
		if (seen.has(fingerprint)) throw new Error("Exact duplicate question in generated batch");
		seen.add(fingerprint);
		const els = elements(q);
		if (!request.include_images && els.some((e) => e.image))
			throw new Error("Unrequested image generation");
		if (request.include_images && !els.some((e) => e.image))
			throw new Error("Missing requested image");
		if (!request.include_audio && els.some((e) => e.audio))
			throw new Error("Unrequested audio generation");
		if (request.include_audio && answerElements(q).some((e) => !e.audio))
			throw new Error("Every answer/item requires a separate audio spec");
	}
}

/** JSON Schema of the draft batch, included in the text-model prompt. Computed once per isolate. */
let draftSchema: unknown;
export function draftJsonSchema(): unknown {
	draftSchema ??= z.toJSONSchema(DraftBatch, { io: "input", unrepresentable: "any" });
	return draftSchema;
}

/** Short, safe description of a zod failure (no echo of full model output). */
export function describeZodError(error: z.ZodError): string {
	return error.issues
		.slice(0, 5)
		.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
		.join("; ");
}
