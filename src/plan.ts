// Deterministic planning of a draft batch: media identities and the DB records per question.
import {
	type AudioSpec,
	type DraftBatch,
	type Element,
	type ImageSpec,
	type QuestionDraft,
	elements,
} from "./schemas.ts";

/** RFC 4122 version-5 UUID (SHA-1), same algorithm as Python's uuid.uuid5. */
export async function uuid5(namespace: string, name: string): Promise<string> {
	const ns = namespace.replace(/-/g, "");
	if (!/^[0-9a-f]{32}$/i.test(ns)) throw new Error("Invalid namespace UUID");
	const nsBytes = new Uint8Array(16);
	for (let i = 0; i < 16; i++) nsBytes[i] = parseInt(ns.slice(i * 2, i * 2 + 2), 16);
	const nameBytes = new TextEncoder().encode(name);
	const input = new Uint8Array(16 + nameBytes.length);
	input.set(nsBytes);
	input.set(nameBytes, 16);
	const hash = new Uint8Array(await crypto.subtle.digest("SHA-1", input)).slice(0, 16);
	hash[6] = (hash[6] & 0x0f) | 0x50;
	hash[8] = (hash[8] & 0x3f) | 0x80;
	const hex = [...hash].map((b) => b.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** JSON with sorted keys, so identical specs always produce the same signature. */
export function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (value && typeof value === "object")
		return `{${Object.keys(value)
			.sort()
			.map((k) => `${JSON.stringify(k)}:${stableJson((value as Record<string, unknown>)[k])}`)
			.join(",")}}`;
	return JSON.stringify(value);
}

export type MediaTask =
	| { id: string; kind: "image"; spec: ImageSpec }
	| { id: string; kind: "audio"; spec: AudioSpec };

/** Unique media requests of the whole batch, in a stable order (identical specs share one file). */
export async function planMedia(jobId: string, batch: DraftBatch): Promise<MediaTask[]> {
	const tasks = new Map<string, MediaTask>();
	for (const q of batch.questions)
		for (const e of elements(q)) {
			if (e.image) {
				const signature = `image:${stableJson(e.image)}`;
				if (!tasks.has(signature))
					tasks.set(signature, { id: await uuid5(jobId, signature), kind: "image", spec: e.image });
			}
			if (e.audio) {
				const signature = `audio:${stableJson(e.audio)}`;
				if (!tasks.has(signature))
					tasks.set(signature, { id: await uuid5(jobId, signature), kind: "audio", spec: e.audio });
			}
		}
	return [...tasks.values()];
}

export type DetailRecord = { table: string; row: Record<string, unknown> };

/** Build the rows for save_generated_question; media ids are derived exactly like planMedia. */
export async function buildRecords(
	jobId: string,
	questionId: string,
	q: QuestionDraft,
): Promise<DetailRecord[]> {
	const mediaId = async (e: Element) => ({
		image_id: e.image ? await uuid5(jobId, `image:${stableJson(e.image)}`) : null,
		audio_id: e.audio ? await uuid5(jobId, `audio:${stableJson(e.audio)}`) : null,
	});
	const records: DetailRecord[] = [];
	const add = (table: string, row: Record<string, unknown> = {}) =>
		records.push({ table, row: { question_id: questionId, ...row } });
	switch (q.question_type) {
		case "COMP_SEL": {
			add("completion_questions", { stem_text: q.stem.text, ...(await mediaId(q.stem)) });
			for (const [position, opt] of q.options.entries())
				add("completion_options", {
					text_content: opt.text,
					is_correct: opt.is_correct,
					position,
					...(await mediaId(opt)),
				});
			break;
		}
		case "TYPING":
			add("typing_questions", {
				stem_text: q.stem.text,
				...(await mediaId(q.stem)),
				answer_text: q.answer.text,
				completed_sentence: q.completed_sentence,
				case_sensitive: q.case_sensitive,
				answer_audio_id: (await mediaId(q.answer)).audio_id,
			});
			break;
		case "MATCH": {
			add("matching_questions");
			for (const [position, pair] of q.pairs.entries()) {
				const left = await mediaId(pair.left);
				const right = await mediaId(pair.right);
				add("matching_pairs", {
					position,
					left_text: pair.left.text,
					right_text: pair.right.text,
					left_image_id: left.image_id,
					left_audio_id: left.audio_id,
					right_image_id: right.image_id,
					right_audio_id: right.audio_id,
				});
			}
			break;
		}
		case "ORDER": {
			add("ordering_questions", {
				correct_sentence: q.answer.text,
				answer_audio_id: (await mediaId(q.answer)).audio_id,
			});
			for (const [correct_position, token] of q.tokens.entries())
				add("ordering_tokens", {
					text_content: token.text,
					correct_position,
					audio_id: (await mediaId(token)).audio_id,
				});
			break;
		}
		case "LISTEN": {
			add("listening_questions");
			for (const [correct_position, item] of q.items.entries())
				add("listening_items", {
					label: item.text,
					spoken_text: item.audio?.transcript ?? item.text,
					correct_position,
					...(await mediaId(item)),
				});
			break;
		}
	}
	return records;
}
