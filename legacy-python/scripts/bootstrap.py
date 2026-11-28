"""python -m scripts.bootstrap --data-dir ../DATA [--apply]
Creates private buckets and imports CSV LO items, not schema. Dry-run is default.
"""

import argparse
import asyncio
import csv
import hashlib
from pathlib import Path
from uuid import NAMESPACE_URL, uuid5

import httpx

from app.config import get_settings
from app.db import Database


def load_los(directory: Path):
    records = []
    for path in sorted(directory.glob("*Khối*.csv")):
        with path.open(encoding="utf-8-sig", newline="") as f:
            reader = csv.reader(f)
            next(reader)
            next(reader)
            for number, row in enumerate(reader, start=3):
                if len(row) != 11 or not row[0].strip().isdigit():
                    continue
                grade, unit = int(row[0]), int(row[1])
                canonical = "|".join(
                    [str(grade), str(unit), row[6].strip(), row[8].strip(), row[9].strip()]
                )
                digest = hashlib.sha256(canonical.encode()).hexdigest()[:12]
                records.append(
                    {
                        "id": str(uuid5(NAMESPACE_URL, "questionbank:lo:" + canonical)),
                        "code": row[10].strip() or f"EN_G{grade}_U{unit}_{digest}",
                        "grade": grade,
                        "unit": unit,
                        "general_name": row[3].strip(),
                        "specific_name": row[6].strip(),
                        "category": row[8].strip(),
                        "content": row[9].strip(),
                        "source_file": path.name,
                        "source_record": number,
                    }
                )
    return records


async def run(args):
    rows = load_los(Path(args.data_dir))
    print(f"LO records: {len(rows)}. Mode: {'APPLY' if args.apply else 'DRY RUN'}")
    if not rows:
        raise SystemExit("No LO source files found")
    if not args.apply:
        return
    s = get_settings()
    async with httpx.AsyncClient(timeout=30) as client:
        db = Database(s, client)
        buckets = await db.request("GET", "/storage/v1/bucket")
        for name in (s.supabase_images_bucket, s.supabase_audios_bucket):
            existing = next((b for b in buckets if b["id"] == name), None)
            if existing and existing.get("public"):
                raise RuntimeError("Configured bucket is public. Review before continuing.")
            if not existing:
                mime = (
                    ["image/png", "image/jpeg", "image/webp"]
                    if name == s.supabase_images_bucket
                    else ["audio/wav", "audio/mpeg"]
                )
                await db.request(
                    "POST",
                    "/storage/v1/bucket",
                    json={
                        "id": name,
                        "name": name,
                        "public": False,
                        "file_size_limit": s.max_media_bytes,
                        "allowed_mime_types": mime,
                    },
                )
        for start in range(0, len(rows), 100):
            await db.request(
                "POST",
                "/rest/v1/learning_objectives",
                params={"on_conflict": "id"},
                json=rows[start : start + 100],
                headers={"Prefer": "resolution=ignore-duplicates"},
            )
    print("Private buckets and LO import completed. Existing rows were not overwritten.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", required=True)
    parser.add_argument("--apply", action="store_true")
    asyncio.run(run(parser.parse_args()))
