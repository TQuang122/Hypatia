#!/usr/bin/env python3
"""Serve a local fine-tuned Laya checkpoint under an explicit Hypatia model alias."""

import argparse
import hashlib
from pathlib import Path


def checkpoint_fingerprint(checkpoint: Path) -> str:
    digest = hashlib.sha256()
    files = sorted(path for path in checkpoint.rglob("*") if path.is_file() and not path.is_symlink())
    if not files:
        raise ValueError("checkpoint directory contains no regular files.")
    for path in files:
        digest.update(path.relative_to(checkpoint).as_posix().encode("utf-8"))
        digest.update(b"\0")
        with path.open("rb") as handle:
            while chunk := handle.read(1024 * 1024):
                digest.update(chunk)
    return f"local-sha256:{digest.hexdigest()}"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkpoint", required=True, type=Path)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", default=8000, type=int)
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--log-level", default="info")
    args = parser.parse_args()

    checkpoint = args.checkpoint.resolve()
    if not (checkpoint / "model.safetensors").is_file() or not (checkpoint / "rl_agent_config.json").is_file():
        raise ValueError("--checkpoint must contain model.safetensors and rl_agent_config.json.")
    if not 1 <= args.port <= 65535:
        raise ValueError("--port must be between 1 and 65535.")

    import uvicorn
    from laya.serve import create_app
    from laya.router import Router

    router = Router(
        models={"english": str(checkpoint)},
        device=args.device,
        default="english",
        max_loaded=1,
    )
    router.preload(["english"])
    router.load("english").revision = checkpoint_fingerprint(checkpoint)
    uvicorn.run(create_app(router), host=args.host, port=args.port, log_level=args.log_level)


if __name__ == "__main__":
    main()
