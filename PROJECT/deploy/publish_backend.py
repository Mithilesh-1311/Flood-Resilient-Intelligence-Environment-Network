"""
publish_backend.py - assemble the FRiEND controller Space, and optionally push it.

    python deploy/publish_backend.py                      # assemble deploy/hf-space only
    python deploy/publish_backend.py --push USER/SPACE    # assemble, create the Space, upload

deploy/hf-space/ holds the hosting wiring (Dockerfile, README, requirements,
HARDWARE/serve.py). Everything else is COPIED in from the project each run, so
the Space always ships the current nc1.py, flood_ai.py, simulate_hardware.py and
model - never a stale fork. Re-run after changing any of them.

Pushing needs `pip install huggingface_hub` and a Hugging Face access token with
WRITE permission (huggingface.co/settings/tokens); you will be prompted for it
once and it is then cached by huggingface_hub.
"""

from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent       # PROJECT/
SPACE = Path(__file__).resolve().parent / "hf-space"

# (source relative to PROJECT/, destination relative to the Space)
FILES = [
    ("HARDWARE/nc1.py", "HARDWARE/nc1.py"),
    ("HARDWARE/flood_ai.py", "HARDWARE/flood_ai.py"),
    ("HARDWARE/simulate_hardware.py", "HARDWARE/simulate_hardware.py"),
    ("HARDWARE/replay_hardware.py", "HARDWARE/replay_hardware.py"),
    # Real held-out gauge rows for the default replay mode (build_replay.py).
    ("flood_dataset/replay_test.csv", "flood_dataset/replay_test.csv"),
    ("flood_dataset/replay_test_meta.json", "flood_dataset/replay_test_meta.json"),
    ("models/flood_gru.keras", "models/flood_gru.keras"),
    ("models/threshold.json", "models/threshold.json"),
    ("models/metrics.json", "models/metrics.json"),
    ("models/onset_metrics.json", "models/onset_metrics.json"),
    ("flood_dataset/preprocess_params.json", "flood_dataset/preprocess_params.json"),
]

# Wiring files that must already exist in deploy/hf-space.
WIRING = ["Dockerfile", "README.md", "requirements.txt", "HARDWARE/serve.py"]


def assemble() -> None:
    missing = [w for w in WIRING if not (SPACE / w).exists()]
    if missing:
        sys.exit(f"deploy/hf-space is missing: {', '.join(missing)}")

    for src, dst in FILES:
        s, d = ROOT / src, SPACE / dst
        if not s.exists():
            sys.exit(f"missing project file: {src}")
        d.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(s, d)
        print(f"  copied  {src}")

    for cache in SPACE.rglob("__pycache__"):
        shutil.rmtree(cache, ignore_errors=True)
    print(f"assembled {SPACE}")


def push(repo_id: str) -> None:
    try:
        from huggingface_hub import HfApi, get_token, login
    except ImportError:
        sys.exit("pip install huggingface_hub   (then re-run with --push)")

    if not get_token():
        print("Paste a Hugging Face token with WRITE access (huggingface.co/settings/tokens):")
        login()

    api = HfApi()
    # Public on purpose: the Vercel dashboard connects from visitors' browsers,
    # which cannot present a token to a private Space.
    api.create_repo(repo_id, repo_type="space", space_sdk="docker", private=False, exist_ok=True)
    api.upload_folder(
        folder_path=str(SPACE),
        repo_id=repo_id,
        repo_type="space",
        commit_message="Deploy FRiEND controller",
        ignore_patterns=["__pycache__/*", "*.pyc"],
    )

    host = None
    try:
        host = getattr(api.space_info(repo_id), "host", None)
    except Exception:  # noqa: BLE001 - the URL is a convenience, not required
        pass
    if not host:
        host = "https://" + "".join(c if c.isalnum() else "-" for c in repo_id.lower()) + ".hf.space"

    print()
    print(f"Space page : https://huggingface.co/spaces/{repo_id}")
    print(f"API URL    : {host}")
    print("The first build installs TensorFlow and takes a few minutes. When the")
    print("Space shows 'Running', set this on Vercel and redeploy:")
    print(f"  VITE_CONTROLLER_URL={host}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--push", metavar="USER/SPACE", help="create/update this Hugging Face Space")
    args = parser.parse_args()
    assemble()
    if args.push:
        push(args.push)


if __name__ == "__main__":
    main()
