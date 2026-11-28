// Runtime settings read from Worker secrets/variables (same names as the Python backend's .env).

export type AudioApi = "chat" | "speech";

export interface Settings {
	supabaseUrl: string;
	supabaseSecretKey: string;
	imagesBucket: string;
	audiosBucket: string;
	corsOrigins: string[];
	openrouterApiKey: string;
	openrouterTextModel: string;
	openrouterAudioModel: string;
	openrouterAudioVoice: string;
	openrouterAudioFallbackModel: string;
	openrouterAudioApi: AudioApi;
	openrouterSpeechInstructions: boolean;
	openrouterAudioSampleRate: number;
	imgGenApiKey: string;
	imgGenBaseUrl: string;
	imagePollSeconds: number;
	imageTimeoutSeconds: number;
	maxMediaBytes: number;
	maxActiveJobs: number;
}

export class ConfigError extends Error {
	override name = "ConfigError";
}

type RawEnv = Record<string, unknown>;

function str(env: RawEnv, key: string, fallback = ""): string {
	const value = env[key];
	return typeof value === "string" ? value.trim() : fallback;
}

function num(env: RawEnv, key: string, fallback: number, min: number, max: number): number {
	const raw = str(env, key);
	if (!raw) return fallback;
	const value = Number(raw);
	if (!Number.isFinite(value) || value < min || value > max)
		throw new ConfigError(`${key} must be between ${min} and ${max}`);
	return value;
}

function list(env: RawEnv, key: string, fallback: string[]): string[] {
	const raw = str(env, key);
	if (!raw) return fallback;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (Array.isArray(parsed) && parsed.every((v) => typeof v === "string"))
			return parsed.map((v) => v.trim());
	} catch {
		// Fall through: also accept a comma-separated list.
	}
	return raw
		.split(",")
		.map((v) => v.trim())
		.filter(Boolean);
}

export function projectUrl(value: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new ConfigError("SUPABASE_URL is missing or invalid");
	}
	if (url.protocol !== "https:" || !url.hostname.endsWith(".supabase.co"))
		throw new ConfigError("Use the HTTPS project API URL, not the Supabase dashboard URL");
	if (!["", "/"].includes(url.pathname) || url.search || url.hash || url.username)
		throw new ConfigError("SUPABASE_URL must be a project root URL");
	return url.origin;
}

const cache = new WeakMap<object, Settings>();

export function loadSettings(env: object): Settings {
	const cached = cache.get(env);
	if (cached) return cached;
	const e = env as RawEnv;
	const audioApi = str(e, "OPENROUTER_AUDIO_API", "chat");
	if (audioApi !== "chat" && audioApi !== "speech")
		throw new ConfigError("OPENROUTER_AUDIO_API must be chat or speech");
	const secret = str(e, "SUPABASE_SECRET_KEY");
	if (!secret) throw new ConfigError("SUPABASE_SECRET_KEY is missing");
	const settings: Settings = {
		supabaseUrl: projectUrl(str(e, "SUPABASE_URL")),
		supabaseSecretKey: secret,
		imagesBucket: str(e, "SUPABASE_IMAGES_BUCKET") || "question-images",
		audiosBucket: str(e, "SUPABASE_AUDIOS_BUCKET") || "question-audios",
		corsOrigins: list(e, "CORS_ORIGINS", ["http://localhost:3000"]),
		openrouterApiKey: str(e, "OPENROUTER_API_KEY"),
		openrouterTextModel: str(e, "OPENROUTER_TEXT_MODEL"),
		// Defaults = previous POC (DATA/config/models.json + audio-policy.json).
		openrouterAudioModel: str(e, "OPENROUTER_AUDIO_MODEL") || "openai/gpt-audio-mini",
		openrouterAudioFallbackModel: str(e, "OPENROUTER_AUDIO_FALLBACK_MODEL") || "openai/gpt-audio",
		openrouterAudioVoice: str(e, "OPENROUTER_AUDIO_VOICE") || "nova",
		openrouterAudioApi: audioApi,
		openrouterSpeechInstructions: str(e, "OPENROUTER_SPEECH_INSTRUCTIONS").toLowerCase() === "true",
		openrouterAudioSampleRate: num(e, "OPENROUTER_AUDIO_SAMPLE_RATE", 24000, 8000, 48000),
		imgGenApiKey: str(e, "IMG_GEN_API_KEY"),
		imgGenBaseUrl: (str(e, "IMG_GEN_BASE_URL") || "https://genimg.tguru.vn:8000").replace(
			/\/+$/,
			"",
		),
		// Free plan: keep polling sparse; each poll is one Workflow step + one subrequest.
		imagePollSeconds: num(e, "IMAGE_POLL_SECONDS", 10, 3, 120),
		imageTimeoutSeconds: num(e, "IMAGE_TIMEOUT_SECONDS", 600, 10, 3600),
		maxMediaBytes: num(e, "MAX_MEDIA_BYTES", 20 * 1024 * 1024, 1024, 100 * 1024 * 1024),
		maxActiveJobs: num(e, "MAX_ACTIVE_JOBS", 3, 1, 20),
	};
	cache.set(env, settings);
	return settings;
}

/** Names of missing settings needed for a generation job (never their values). */
export function generationErrors(s: Settings, opts: { images: boolean; audio: boolean }): string[] {
	const missing: string[] = [];
	if (!s.openrouterApiKey) missing.push("OPENROUTER_API_KEY");
	if (!s.openrouterTextModel) missing.push("OPENROUTER_TEXT_MODEL");
	if (opts.images && !s.imgGenApiKey) missing.push("IMG_GEN_API_KEY");
	if (opts.audio) {
		if (!s.openrouterAudioModel) missing.push("OPENROUTER_AUDIO_MODEL");
		if (!s.openrouterAudioVoice) missing.push("OPENROUTER_AUDIO_VOICE");
	}
	return missing;
}
