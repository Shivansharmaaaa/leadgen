"""
Fetch Google's Schema-Guided Dialogue dataset and keep the appointment dialogues.

    python finetune/fetch_sgd.py      # -> data/raw/sgd/services_single_domain.json

Rastogi et al. 2020, CC BY-SA 4.0.
https://github.com/google-research-datasets/dstc8-schema-guided-dialogue

Keeps single-service dialogues from the four appointment services (salon,
dentist, doctor, therapist). Multi-service dialogues mix in flights and
restaurants, which have nothing to teach a booking line.
"""

from __future__ import annotations

import json
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data/raw/sgd"
BASE = "https://raw.githubusercontent.com/google-research-datasets/dstc8-schema-guided-dialogue/master"
FILES = {"train": 127, "dev": 20, "test": 34}
KEEP = {"Services_1", "Services_2", "Services_3", "Services_4"}


def fetch(split: str, n: int) -> list[dict]:
    path = RAW / split / f"dialogues_{n:03d}.json"
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        with urllib.request.urlopen(f"{BASE}/{split}/{path.name}", timeout=120) as res:
            path.write_bytes(res.read())
    return [d for d in json.loads(path.read_text()) if len(d["services"]) == 1 and d["services"][0] in KEEP]


def main():
    out: dict[str, list[dict]] = {}
    with ThreadPoolExecutor(8) as pool:
        for split, count in FILES.items():
            parts = pool.map(lambda n: fetch(split, n), range(1, count + 1))
            out[split] = [d for part in parts for d in part]
            print(f"{split}: {len(out[split])} appointment dialogues")
    (RAW / "services_single_domain.json").write_text(json.dumps(out))
    print(f"✓ {RAW / 'services_single_domain.json'}")


if __name__ == "__main__":
    main()
