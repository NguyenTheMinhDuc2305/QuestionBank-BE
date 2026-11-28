import { loadSettings } from "../src/settings.ts";

export const ENV = {
	SUPABASE_URL: "https://test.supabase.co",
	SUPABASE_SECRET_KEY: "sb_secret_dummy",
	CORS_ORIGINS: '["http://localhost:3000"]',
};

export function settings(extra: Record<string, string> = {}) {
	return loadSettings({ ...ENV, ...extra });
}

export function completion(): Record<string, unknown> {
	return {
		question_type: "COMP_SEL",
		stem: { text: "I write with a ___." },
		options: ["pen", "bag", "cat", "bus"].map((text) => ({ text, is_correct: text === "pen" })),
	};
}

/** fetch stub that routes by a handler and records requests. */
export function mockFetch(handler: (req: Request) => Response | Promise<Response>) {
	const seen: Request[] = [];
	const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const req = new Request(input, init);
		seen.push(req.clone());
		return handler(req);
	}) as typeof fetch;
	return { fn, seen };
}
