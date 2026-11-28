// Durable generation job: replaces the Python worker process.
//
// Workers Free allows 50 external subrequests per invocation, and a Workflow instance can run all
// of its steps (including short sleeps) in ONE invocation. So a job is processed by a CHAIN of
// Workflow instances: each instance spends at most BUDGET subrequests (static cost per step, so the
// split is deterministic on replay), then starts the next instance with a cursor and returns.
// Creating an instance is an internal Cloudflare call and does not count toward the 50.
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { type MediaTask, buildRecords, planMedia, uuid5 } from "./plan.ts";
import {
	ProviderError,
	Providers,
	TGURU_DEFAULT_MODEL,
	effectiveImagePrompt,
} from "./providers.ts";
import { type DraftBatch, DraftBatch as DraftSchema, type JobConfig } from "./schemas.ts";
import { type Settings, loadSettings } from "./settings.ts";
import { Database } from "./supabase.ts";

/** Resume point: unit index (media tasks, then questions, then completion) + image poll state. */
export type Cursor = { unit: number; providerJob?: string; polls?: number };
export type JobParams = { jobId: string; seq?: number; cursor?: Cursor };
/** Learning-objective row as plain JSON (step results must be serializable). */
type LoRow = Record<string, string | number | boolean | null>;

/** External subrequests per instance. Free plan hard limit is 50; the rest covers retries + "mark failed". */
export const BUDGET = 40;
/** Maximum external subrequests made by each step kind. */
export const COST = {
	load: 2, // job + learning objective
	mark: 1,
	draft: 1,
	checkpoint: 1,
	state: 1, // continuation: job config + checkpointed draft
	submit: 1,
	poll: 1,
	store: 3, // download + upload + insert
	audio: 4, // exists check + OpenRouter + upload + insert (fallback model only after a failed call)
	save: 1,
	complete: 1,
} as const;

const DB_STEP = {
	retries: { limit: 2, delay: "5 seconds", backoff: "exponential" },
	timeout: "2 minutes",
} as const;
const POLL_STEP = {
	retries: { limit: 2, delay: "10 seconds", backoff: "constant" },
	timeout: "1 minute",
} as const;
// Billed calls without a confirmed idempotency guarantee: at most one automatic retry.
const BILLED_STEP = {
	retries: { limit: 1, delay: "15 seconds", backoff: "constant" },
	timeout: "5 minutes",
} as const;
const MEDIA_EXT: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/webp": "webp",
	"audio/wav": "wav",
	"audio/mpeg": "mp3",
};

async function sha256Hex(data: Uint8Array): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
	return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Error text stored on the job. Errors crossing a step boundary lose their class, so use name +
 * message: our own messages never contain keys or upstream bodies, and the text is truncated.
 */
export function safeJobError(error: unknown): string {
	let name = error instanceof Error && error.name ? error.name : "Error";
	let message = error instanceof Error ? error.message.replace(/\s+/g, " ").slice(0, 300) : "";
	// NonRetryableError wraps our message as "NonRetryableError: <message>".
	const wrapped = /^(\w*Error): (.*)$/.exec(message);
	if (wrapped && name === "Error") [, name, message] = wrapped;
	return `${name}: ${message || "generation failed"}. Inspect the Workflow instance; billed provider calls are retried at most once.`;
}

type RunResult = { questions: number } | { continued: string } | null;

export class GenerateJobWorkflow extends WorkflowEntrypoint<Env, JobParams> {
	private deps(): { s: Settings; db: Database; providers: Providers } {
		const s = loadSettings(this.env);
		return { s, db: new Database(s), providers: new Providers(s) };
	}

	async run(event: WorkflowEvent<JobParams>, step: WorkflowStep): Promise<RunResult> {
		const { jobId } = event.payload;
		const seq = event.payload.seq ?? 0;
		let used = 0;
		const fits = (cost: number) => used + cost <= BUDGET;
		try {
			let config: JobConfig;
			let draft: DraftBatch;
			if (seq === 0) {
				const job = await step.do("load job", DB_STEP, async () => {
					const { db } = this.deps();
					const [row] = await db.select<{ config: JobConfig; status: string }>("generation_jobs", {
						select: "config,status",
						id: `eq.${jobId}`,
					});
					if (!row) throw new NonRetryableError("Job not found");
					if (row.status !== "queued" && row.status !== "running")
						return { status: row.status, config: row.config, lo: null as LoRow | null };
					const [lo] = await db.select<LoRow>("learning_objectives", {
						id: `eq.${row.config.lo_id}`,
					});
					if (!lo) throw new NonRetryableError("Learning objective not found");
					return { status: row.status, config: row.config, lo: lo as LoRow | null };
				});
				used += COST.load;
				if (!job.lo) return null;
				const lo = job.lo;
				config = job.config;

				await step.do("mark running", DB_STEP, async () => {
					const lease = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
					// worker_id = job id: save_generated_question only accepts writes from the lease owner.
					await this.deps().db.patch(
						"generation_jobs",
						{
							status: "running",
							worker_id: jobId,
							lease_until: lease,
							error: null,
							updated_at: new Date().toISOString(),
						},
						{ id: `eq.${jobId}`, status: "in.(queued,running)" },
					);
				});
				used += COST.mark;

				draft = await step.do("generate draft", BILLED_STEP, async () => {
					try {
						return await this.deps().providers.content(config, lo);
					} catch (error) {
						// A provider 4xx (bad key/model) will not fix itself: do not retry and bill again.
						if (
							error instanceof ProviderError &&
							error.status >= 400 &&
							error.status < 500 &&
							error.status !== 429
						)
							throw new NonRetryableError(error.message);
						throw error;
					}
				});
				used += COST.draft;

				await step.do("checkpoint draft", DB_STEP, async () => {
					await this.deps().db.patch(
						"generation_jobs",
						{ checkpoint: { draft } },
						{ id: `eq.${jobId}` },
					);
				});
				used += COST.checkpoint;
			} else {
				const state = await step.do("load state", DB_STEP, async () => {
					const [row] = await this.deps().db.select<{
						config: JobConfig;
						status: string;
						checkpoint: { draft?: DraftBatch } | null;
					}>("generation_jobs", { select: "config,status,checkpoint", id: `eq.${jobId}` });
					if (!row?.checkpoint?.draft)
						throw new NonRetryableError("Job or its draft checkpoint not found");
					return { status: row.status, config: row.config, draft: row.checkpoint.draft };
				});
				used += COST.state;
				if (state.status !== "running") return null;
				config = state.config;
				draft = state.draft;
			}

			const batch = DraftSchema.parse(draft);
			const tasks = await planMedia(jobId, batch);
			const questionsEnd = tasks.length + batch.questions.length;
			const start = event.payload.cursor ?? { unit: 0 };
			const s = loadSettings(this.env);
			const maxPolls = Math.ceil(s.imageTimeoutSeconds / s.imagePollSeconds);

			for (let unit = start.unit; unit <= questionsEnd; unit++) {
				const resume: Cursor = unit === start.unit ? start : { unit };
				if (unit < tasks.length) {
					const task = tasks[unit];
					if (task.kind === "audio") {
						if (!fits(COST.audio)) return await this.continueAt(step, jobId, seq, { unit });
						await this.audio(step, jobId, unit, task);
						used += COST.audio;
						continue;
					}
					let providerJob = resume.providerJob;
					let polls = resume.polls ?? 0;
					if (!providerJob) {
						if (!fits(COST.submit + COST.poll + COST.store))
							return await this.continueAt(step, jobId, seq, { unit });
						providerJob = await this.imageSubmit(step, unit, task);
						used += COST.submit;
					}
					let ready: { url: string; model: string } | null = null;
					while (!ready) {
						if (polls >= maxPolls)
							throw new ProviderError("Image polling timed out; provider job may still be running");
						// Each poll must leave room for the store step if the image turns out to be ready.
						if (!fits(COST.poll + COST.store))
							return await this.continueAt(step, jobId, seq, { unit, providerJob, polls });
						// Sleeping costs no CPU and does not hold a concurrency slot.
						await step.sleep(`image ${unit} wait ${polls}`, `${s.imagePollSeconds} seconds`);
						const job = providerJob;
						const result = await step.do(`image ${unit} poll ${polls}`, POLL_STEP, () =>
							this.deps().providers.imagePoll(job),
						);
						used += COST.poll;
						polls++;
						if (result.state === "failed")
							throw new ProviderError("Image generation failed or cancelled at the provider");
						if (result.state === "ready") ready = result;
					}
					await this.imageStore(step, jobId, unit, task, providerJob, ready);
					used += COST.store;
				} else if (unit < questionsEnd) {
					if (!fits(COST.save)) return await this.continueAt(step, jobId, seq, { unit });
					const index = unit - tasks.length;
					const question = batch.questions[index];
					await step.do(`save question ${index}`, DB_STEP, async () => {
						const questionId = await uuid5(jobId, `question:${index}`);
						await this.deps().db.rpc("save_generated_question", {
							p_job: jobId,
							p_worker: jobId,
							p_lo: config.lo_id,
							p_question: {
								id: questionId,
								question_type: question.question_type,
								bloom_level: config.bloom_level,
								instruction_text: question.instruction_text,
								hint: question.hint,
								explanation: question.explanation,
								item_index: index,
							},
							p_records: await buildRecords(jobId, questionId, question),
						});
					});
					used += COST.save;
				} else {
					if (!fits(COST.complete)) return await this.continueAt(step, jobId, seq, { unit });
					await step.do("mark completed", DB_STEP, async () => {
						await this.deps().db.patch(
							"generation_jobs",
							{ status: "completed", error: null, updated_at: new Date().toISOString() },
							{ id: `eq.${jobId}`, status: "eq.running" },
						);
					});
					used += COST.complete;
				}
			}
			return { questions: batch.questions.length };
		} catch (error) {
			// Not budgeted: the 10 spare subrequests are reserved for this.
			await step.do("mark failed", DB_STEP, async () => {
				await this.deps().db.patch(
					"generation_jobs",
					{ status: "failed", error: safeJobError(error), updated_at: new Date().toISOString() },
					{ id: `eq.${jobId}`, status: "in.(queued,running)" },
				);
			});
			throw error;
		}
	}

	/** Start the next instance of the chain (fresh invocation, fresh subrequest budget). */
	private async continueAt(
		step: WorkflowStep,
		jobId: string,
		seq: number,
		cursor: Cursor,
	): Promise<RunResult> {
		const next = seq + 1;
		const id = `${jobId}-${next}`;
		await step.do(`continue as ${next}`, DB_STEP, async () => {
			try {
				await this.env.GENERATE_JOB.create({ id, params: { jobId, seq: next, cursor } });
			} catch (error) {
				// A retried step may find the instance already created.
				if (!/already exists|duplicate/i.test(String(error))) throw error;
			}
		});
		return { continued: id };
	}

	private async imageSubmit(
		step: WorkflowStep,
		unit: number,
		task: Extract<MediaTask, { kind: "image" }>,
	): Promise<string> {
		// tguru idempotency key = media id: a retried submit returns the same provider job.
		return await step.do(`image ${unit} submit`, BILLED_STEP, () =>
			this.deps().providers.imageSubmit(task.spec, task.id),
		);
	}

	private async imageStore(
		step: WorkflowStep,
		jobId: string,
		unit: number,
		task: Extract<MediaTask, { kind: "image" }>,
		providerJob: string,
		found: { url: string; model: string },
	): Promise<void> {
		await step.do(`image ${unit} store`, DB_STEP, async () => {
			const { s, db, providers } = this.deps();
			const { data, mime } = await providers.imageDownload(found.url);
			const key = `generated/${jobId}/${task.id}.${MEDIA_EXT[mime]}`;
			await db.upload(s.imagesBucket, key, data, mime);
			await db.insert(
				"images",
				{
					id: task.id,
					bucket: s.imagesBucket,
					object_key: key,
					file_hash: await sha256Hex(data),
					prompt: task.spec.prompt,
					negative_prompt: task.spec.negative_prompt,
					effective_prompt: effectiveImagePrompt(task.spec),
					model_name: found.model || TGURU_DEFAULT_MODEL,
					provider_job_id: providerJob,
					generation_params: { provider: "tguru", base_url: s.imgGenBaseUrl },
				},
				{ ignoreDuplicates: true },
			);
		});
	}

	private async audio(
		step: WorkflowStep,
		jobId: string,
		unit: number,
		task: Extract<MediaTask, { kind: "audio" }>,
	): Promise<void> {
		// Generate + upload in one step: audio bytes can exceed the 1 MiB step-result limit.
		// The object key is deterministic, so a retried upload overwrites instead of duplicating.
		await step.do(`audio ${unit}`, BILLED_STEP, async () => {
			const { s, db, providers } = this.deps();
			if ((await db.select("audios", { select: "id", id: `eq.${task.id}` })).length) return;
			const { data, mime, model } = await providers.audio(task.spec);
			const key = `generated/${jobId}/${task.id}.${MEDIA_EXT[mime]}`;
			await db.upload(s.audiosBucket, key, data, mime);
			await db.insert(
				"audios",
				{
					id: task.id,
					bucket: s.audiosBucket,
					object_key: key,
					file_hash: await sha256Hex(data),
					transcript: task.spec.transcript,
					description: task.spec.description,
					model_name: model,
					voice: s.openrouterAudioVoice,
					generation_params: {
						api: s.openrouterAudioApi,
						format: s.openrouterAudioApi === "chat" ? "pcm16->wav" : "mp3",
						// Like the previous POC, chat TTS sends only the fixed TTS instruction + transcript.
						description_sent: s.openrouterAudioApi === "speech" && s.openrouterSpeechInstructions,
						sample_rate: s.openrouterAudioApi === "chat" ? s.openrouterAudioSampleRate : null,
					},
				},
				{ ignoreDuplicates: true },
			);
		});
	}
}
