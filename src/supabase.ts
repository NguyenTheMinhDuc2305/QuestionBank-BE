// Minimal Supabase REST/Storage client using the backend-only secret key.
import type { Settings } from "./settings.ts";

export class DatabaseError extends Error {
	override name = "DatabaseError";
	constructor(
		message: string,
		readonly status = 0,
	) {
		super(message);
	}
}

export type Fetcher = typeof fetch;
/** Call the global fetch unbound: storing `fetch` on an object and calling it as a method throws "Illegal invocation". */
export const defaultFetch: Fetcher = (input, init) => fetch(input, init);
type Params = Record<string, string | number | undefined>;
export type Row = Record<string, unknown>;

export function encodeKey(key: string): string {
	return key.split("/").map(encodeURIComponent).join("/");
}

export class Database {
	private readonly headers: Record<string, string>;

	constructor(
		readonly s: Settings,
		private readonly fetcher: Fetcher = defaultFetch,
	) {
		const key = s.supabaseSecretKey;
		this.headers = { apikey: key };
		// Legacy service_role JWT needs Authorization; sb_secret_ keys are not JWTs.
		if (key.split(".").length === 3) this.headers.Authorization = `Bearer ${key}`;
	}

	async request<T = unknown>(
		method: string,
		path: string,
		opts: { params?: Params; json?: unknown; headers?: Record<string, string> } = {},
	): Promise<T> {
		const url = new URL(this.s.supabaseUrl + path);
		for (const [k, v] of Object.entries(opts.params ?? {}))
			if (v !== undefined) url.searchParams.set(k, String(v));
		const headers: Record<string, string> = { ...this.headers, ...opts.headers };
		if (opts.json !== undefined) headers["Content-Type"] = "application/json";
		const response = await this.fetcher(url, {
			method,
			headers,
			body: opts.json === undefined ? undefined : JSON.stringify(opts.json),
			signal: AbortSignal.timeout(30_000),
		});
		const body = await response.text();
		if (!response.ok)
			// Never include the response body or keys; only the operation and status.
			throw new DatabaseError(
				`Supabase HTTP ${response.status}; operation ${method} ${path.split("?")[0]}`,
				response.status,
			);
		return (body ? JSON.parse(body) : null) as T;
	}

	select<T = Row>(table: string, params: Params = {}): Promise<T[]> {
		return this.request<T[]>("GET", `/rest/v1/${table}`, { params });
	}

	insert(
		table: string,
		row: Row | Row[],
		opts: { ignoreDuplicates?: boolean } = {},
	): Promise<Row[] | null> {
		const prefer = opts.ignoreDuplicates
			? "resolution=ignore-duplicates,return=minimal"
			: "return=representation";
		return this.request("POST", `/rest/v1/${table}`, {
			json: row,
			params: opts.ignoreDuplicates ? { on_conflict: "id" } : {},
			headers: { Prefer: prefer },
		});
	}

	patch(table: string, row: Row, params: Params): Promise<Row[]> {
		return this.request<Row[]>("PATCH", `/rest/v1/${table}`, {
			params,
			json: row,
			headers: { Prefer: "return=representation" },
		});
	}

	rpc<T = unknown>(name: string, body: Row): Promise<T> {
		return this.request<T>("POST", `/rest/v1/rpc/${name}`, { json: body });
	}

	/** Idempotent upload: deterministic object keys, so overwriting on retry is safe. */
	async upload(bucket: string, key: string, data: Uint8Array, mime: string): Promise<void> {
		const response = await this.fetcher(
			`${this.s.supabaseUrl}/storage/v1/object/${encodeURIComponent(bucket)}/${encodeKey(key)}`,
			{
				method: "POST",
				headers: { ...this.headers, "Content-Type": mime, "x-upsert": "true" },
				body: data,
				signal: AbortSignal.timeout(60_000),
			},
		);
		await response.body?.cancel();
		if (!response.ok)
			throw new DatabaseError(`Storage upload HTTP ${response.status}`, response.status);
	}

	async signedUrl(bucket: string, key: string, expiresIn = 600): Promise<string> {
		const data = await this.request<Record<string, string>>(
			"POST",
			`/storage/v1/object/sign/${encodeURIComponent(bucket)}/${encodeKey(key)}`,
			{ json: { expiresIn } },
		);
		const url = data?.signedURL ?? data?.signedUrl ?? "";
		if (!url) throw new DatabaseError("Storage did not return a signed URL");
		return url.startsWith("/") ? `${this.s.supabaseUrl}/storage/v1${url}` : url;
	}
}
