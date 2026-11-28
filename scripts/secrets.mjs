// Build a Worker secrets file from the shared ../.env (outside the repo).
// Usage: node scripts/secrets.mjs <output-file> [source-env]
// Prints key NAMES only, never values. Output files are git-ignored (.env*, .dev.vars*).
import { readFileSync, writeFileSync } from "node:fs";

const ALLOWED = [
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
];

const [output, source = "../.env"] = process.argv.slice(2);
if (!output) {
	console.error("Usage: node scripts/secrets.mjs <output-file> [source-env]");
	process.exit(1);
}

const values = {};
for (const raw of readFileSync(source, "utf8").split(/\r?\n/)) {
	const line = raw.trim();
	if (!line || line.startsWith("#")) continue;
	const eq = line.indexOf("=");
	if (eq < 1) continue;
	const key = line.slice(0, eq).trim();
	let value = line.slice(eq + 1).trim();
	if (/^(['"]).*\1$/.test(value) && !value.startsWith("[")) value = value.slice(1, -1);
	if (ALLOWED.includes(key) && value) values[key] = value;
}

for (const required of ["SUPABASE_URL", "SUPABASE_SECRET_KEY"])
	if (!values[required]) {
		console.error(`Missing ${required} in ${source}`);
		process.exit(1);
	}

// *.json → JSON (for `cf deploy --secrets-file`); otherwise dotenv (for local `.dev.vars`).
// Single quotes keep values such as CORS_ORIGINS=["..."] intact.
const body = output.endsWith(".json")
	? JSON.stringify(values, null, 2)
	: Object.entries(values)
			.map(([k, v]) => `${k}='${v.replace(/'/g, "")}'`)
			.join("\n") + "\n";
writeFileSync(output, body, { mode: 0o600 });
const empty = ALLOWED.filter((k) => !values[k]);
console.error(
	`Wrote ${Object.keys(values).length} secrets to ${output}: ${Object.keys(values).join(", ")}`,
);
if (empty.length) console.error(`Not set (optional or still empty): ${empty.join(", ")}`);
