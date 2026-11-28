import { bindings, defineConfig, exports } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

const WORKER_NAME = "questionbank-worker";
const WORKFLOW_NAME = "questionbank-generate";

// All values are Worker secrets uploaded from the shared ../.env (never committed), see
// scripts/secrets.mjs. Only the Supabase pair is mandatory; /v1/config reports which provider
// settings are still missing. Locally, only declared secrets are loaded from .dev.vars.
const SECRET_NAMES = [
	"SUPABASE_URL",
	"SUPABASE_SECRET_KEY",
	"SUPABASE_IMAGES_BUCKET",
	"SUPABASE_AUDIOS_BUCKET",
	"CORS_ORIGINS",
	"OPENROUTER_API_KEY",
	"OPENROUTER_TEXT_MODEL",
	"OPENROUTER_AUDIO_MODEL",
	"OPENROUTER_AUDIO_VOICE",
	"OPENROUTER_AUDIO_FALLBACK_MODEL",
	"OPENROUTER_AUDIO_API",
	"OPENROUTER_SPEECH_INSTRUCTIONS",
	"OPENROUTER_AUDIO_SAMPLE_RATE",
	"IMG_GEN_API_KEY",
	"IMG_GEN_BASE_URL",
	"IMAGE_POLL_SECONDS",
	"IMAGE_TIMEOUT_SECONDS",
	"MAX_MEDIA_BYTES",
	"MAX_ACTIVE_JOBS",
] as const;
const REQUIRED = new Set<string>(["SUPABASE_URL", "SUPABASE_SECRET_KEY"]);
const secretBindings = (all: boolean) =>
	Object.fromEntries(
		SECRET_NAMES.filter((name) => all || REQUIRED.has(name)).map((name) => [
			name,
			bindings.secret(),
		]),
	) as Record<(typeof SECRET_NAMES)[number], ReturnType<typeof bindings.secret>>;

// Deploy: only the Supabase pair is required (empty provider keys must not block a deploy; the
// secrets file still uploads every non-empty value). Dev/test: declare all so .dev.vars loads them.
export default defineConfig(({ mode }) => ({
	worker: {
		name: WORKER_NAME,
		compatibilityDate: "2026-11-23",
		entrypoint,
		observability: { enabled: true },
		env: {
			...secretBindings(mode === "development" || mode === "test"),
			GENERATE_JOB: bindings.workflow({
				name: WORKFLOW_NAME,
				worker: WORKER_NAME,
				exportName: "GenerateJobWorkflow",
			}),
		},
		exports: {
			GenerateJobWorkflow: exports.workflow({
				name: WORKFLOW_NAME,
				// A heavy job (10 LISTEN questions with media) stays well below this.
				limits: { steps: 1000 },
				// Free plan: keep concurrent jobs small; queued instances start automatically.
				concurrency: { limit: 3 },
				defaultRetention: { successRetention: "3 days", errorRetention: "3 days" },
			}),
		},
	},
}));
