from urllib.parse import quote

import httpx

from app.config import Settings


class DatabaseError(RuntimeError):
    pass


class Database:
    def __init__(self, settings: Settings, client: httpx.AsyncClient):
        self.s = settings
        self.client = client
        self.base = settings.supabase_url
        key = settings.supabase_secret_key.get_secret_value()
        self.headers = {"apikey": key}
        if key.count(".") == 2:  # Legacy JWT service_role; sb_secret_ is NOT a JWT.
            self.headers["Authorization"] = f"Bearer {key}"

    async def request(self, method: str, path: str, *, params=None, json=None, headers=None):
        r = await self.client.request(
            method,
            self.base + path,
            params=params,
            json=json,
            headers={**self.headers, **(headers or {})},
        )
        if r.is_error:
            raise DatabaseError(
                f"Supabase HTTP {r.status_code}; operation {method} {path.split('?')[0]}"
            )
        return r.json() if r.content else None

    async def select(self, table, **params):
        return await self.request("GET", f"/rest/v1/{table}", params=params)

    async def insert(self, table, row):
        return await self.request(
            "POST", f"/rest/v1/{table}", json=row, headers={"Prefer": "return=representation"}
        )

    async def patch(self, table, row, **params):
        return await self.request(
            "PATCH",
            f"/rest/v1/{table}",
            params=params,
            json=row,
            headers={"Prefer": "return=representation"},
        )

    async def rpc(self, name, body):
        return await self.request("POST", f"/rest/v1/rpc/{name}", json=body)

    async def upload(self, bucket: str, key: str, data: bytes, mime: str):
        r = await self.client.post(
            self.base + f"/storage/v1/object/{quote(bucket, safe='')}/{quote(key, safe='/')}",
            headers={**self.headers, "Content-Type": mime, "x-upsert": "false"},
            content=data,
        )
        if r.is_error:
            raise DatabaseError(f"Storage upload HTTP {r.status_code}")

    async def signed_url(self, bucket, key):
        data = await self.request(
            "POST",
            f"/storage/v1/object/sign/{quote(bucket, safe='')}/{quote(key, safe='/')}",
            json={"expiresIn": 600},
        )
        url = data.get("signedURL", data.get("signedUrl", ""))
        if not url:
            raise DatabaseError("Storage did not return a signed URL")
        return self.base + "/storage/v1" + url if url.startswith("/") else url
