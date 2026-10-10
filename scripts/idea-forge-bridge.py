"""Private, bounded adapter for a local AutoResearch clone (no publisher entrypoint)."""
import sys, os, json, hashlib, time, copy, signal
from importlib.metadata import version as package_version
from pathlib import Path
from contextlib import redirect_stdout, redirect_stderr
from datetime import datetime, timezone

class StopRun(BaseException):
    pass

def digest(raw):
    return hashlib.sha256(raw).hexdigest()

def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()

def atomic(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    with open(temporary, "wb") as handle:
        os.chmod(temporary, 0o600)
        handle.write(encoded(value)); handle.flush(); os.fsync(handle.fileno())
    os.replace(temporary, path)

def emit(value):
    sys.__stdout__.write(json.dumps(value, ensure_ascii=False) + "\n"); sys.__stdout__.flush()

class Quiet:
    def write(self, text):
        return len(text)
    def flush(self):
        pass

def prepare(root, panel=None):
    root = Path(root).resolve(strict=True)
    sys.path.insert(0, str(root / "src"))
    # Upstream credentials remain in its environment; no Pi OAuth export or config writes.
    from dotenv import load_dotenv
    load_dotenv(root / ".env", override=False)
    explicit = os.environ.get("AUTORESEARCH_CONFIG")
    if explicit and not Path(explicit).expanduser().is_absolute():
        os.environ["AUTORESEARCH_CONFIG"] = str(root / Path(explicit).expanduser())
    import llm_client, providers, roles
    cfg = copy.deepcopy(llm_client.load_config())
    active = {}
    for role in ("ideator", "planner", "consensus_checker", "freshness_refresher"):
        active[role] = llm_client.configured_role_models(role, cfg)
    if panel:
        active["ideator"] = panel
    for role, names in active.items():
        cfg.setdefault("roles", {}).setdefault(role, {})["models"] = names
    # Freeze the effective routes, including the upstream AR_MODEL overrides already resolved.
    roles.models_for = lambda role, recommended, env=None: list(active.get(role, recommended))
    cfg["execution"] = {**cfg.get("execution", {}), "max_concurrency": 1}
    llm_client.load_config = lambda: copy.deepcopy(cfg)
    profiles = providers.as_profiles(cfg)
    models = []
    for alias, profile in profiles.items():
        models.append({"alias": alias, "identity": providers.model_identity(cfg, alias), "ready": profile.get("api") in providers.DIALECTS and not providers.unmet_requirements(profile), "api": profile.get("api", ""), "transport": profile.get("transport", "httpx")})
    from idea_forge import b_library
    directions = []
    for name in b_library.available_knowledge_files():
        item = b_library.get_b_by_id(name)
        if item:
            path = b_library.knowledge_path(item["knowledge_md"])
            directions.append({"id": item["id"], "title": item["domain"], "file": path.name, "hash": digest(path.read_bytes())})
    sources = {str(path.relative_to(root)): digest(path.read_bytes()) for path in sorted((root / "src").rglob("*.py"))}
    # Hash resolved environment indirections without exposing their values or names.
    environment = {name: digest(os.environ.get(name, "").encode()) for name in sorted(providers.referenced_env_names(cfg))}
    runtime_versions = {name: package_version(name) for name in ("httpx", "python-dotenv", "arxiv")}
    identities = [providers.model_identity(cfg, name) for name in active["ideator"]]
    ready = len(identities) >= 3 and len(identities) == len(set(identities))
    for role, names in active.items():
        eligible = [name for name in names if name in profiles and profiles[name].get("api") in providers.DIALECTS and not providers.unmet_requirements(profiles[name]) and profiles[name].get("transport", "httpx") == "httpx"]
        ready = ready and all(name in profiles for name in names) and (len(eligible) >= 3 and len(eligible) == len(names) if role == "ideator" else bool(eligible))
    metadata = {"version": 1, "models": models, "roles": active, "directions": directions, "configHash": digest(encoded({"config": cfg, "environment": environment, "runtimeVersions": runtime_versions})), "sourceHash": digest(encoded(sources)), "sources": sources, "ready": bool(ready), "minimumPanel": 3, "pythonVersion": sys.version.split()[0], "dependencyVersions": runtime_versions}
    return root, cfg, metadata, llm_client, providers, b_library

def load_ledger(path):
    text = path.read_bytes() if path.exists() else b""
    if text and not text.endswith(b"\n"):
        raise StopRun("Request journal is incomplete; preserve it for inspection.")
    events = []
    previous = ""
    for raw in text.splitlines():
        event = json.loads(raw)
        claimed = event.pop("hash")
        if event["seq"] != len(events) + 1 or event["previousHash"] != previous or digest(encoded(event)) != claimed:
            raise StopRun("Request journal integrity check failed.")
        event["hash"] = claimed; events.append(event); previous = claimed
    return events

def generate(root, request):
    spec = request["spec"]
    root, cfg, metadata, client, providers, b_library = prepare(root, spec["modelPanel"])
    if metadata["configHash"] != spec["backend"]["configHash"] or metadata["sourceHash"] != spec["backend"]["sourceHash"]:
        raise StopRun("AutoResearch config/environment/source changed; create a new generation contract.")
    if not metadata["ready"]:
        raise StopRun("A complete distinct panel and configured support roles are required.")
    if digest(Path(__file__).read_bytes()) != spec["backend"]["bridgeHash"]:
        raise StopRun("Bridge source changed after approval.")
    run = Path(request["runRoot"]).resolve(strict=True)
    journal = run / "requests.jsonl"
    events = load_ledger(journal)
    def log(kind, data):
        unsigned = {"seq": len(events) + 1, "previousHash": events[-1]["hash"] if events else "", "kind": kind, "data": data}
        value = {**unsigned, "hash": digest(encoded(unsigned))}
        with open(journal, "ab") as handle:
            os.chmod(journal, 0o600); handle.write(encoded(value) + b"\n"); handle.flush(); os.fsync(handle.fileno())
        events.append(value)
    calls = sum(e["kind"] == "request_reserved" for e in events)
    deadline = float(request["deadline"])
    profiles = providers.as_profiles(cfg)
    active_alias = {"value": ""}
    observed_panel = {}
    def observe_panel(alias, model):
        if alias not in spec["modelPanel"] or not model:
            return
        aliases = observed_panel.setdefault(model.strip().lower(), set())
        aliases.add(alias)
        if len(aliases) > 1:
            raise StopRun("Panel endpoints reported the same model for multiple aliases; independent cross-review is blocked.")
    for event in events:
        if event["kind"] == "request_finished":
            observe_panel(event["data"].get("alias"), event["data"].get("responseModel"))
    original_call = providers.call
    last_response = {"model": None, "usage": {}}
    original_decode = providers._decode
    def decode(response, elapsed):
        result = original_decode(response, elapsed)
        payload = result[0]
        last_response["model"] = payload.get("model") if isinstance(payload, dict) and isinstance(payload.get("model"), str) else None
        last_response["usage"] = payload.get("usage", {}) if isinstance(payload, dict) and isinstance(payload.get("usage", {}), dict) else {}
        return result
    providers._decode = decode
    def send(dialect, endpoint, model, prompt, **params):
        nonlocal calls
        if calls >= spec["maxRequests"] or time.time() >= deadline:
            raise StopRun("Generation request/time budget exhausted.")
        calls += 1; last_response["model"] = None; last_response["usage"] = {}
        number = calls
        log("request_reserved", {"request": number, "alias": active_alias["value"], "requestedModel": model, "promptHash": digest(prompt.encode())})
        emit({"type": "progress", "requests": calls, "maxRequests": spec["maxRequests"], "stage": "model_request"})
        reply = original_call(dialect, endpoint, model, prompt, **params)
        usage = {key: value for key, value in (reply.usage or last_response["usage"]).items() if isinstance(value, int) and not isinstance(value, bool) and value >= 0}
        log("request_finished", {"request": number, "alias": active_alias["value"], "requestedModel": model, "responseModel": last_response["model"], "outcome": reply.outcome, "finishReason": reply.finish_reason, "usage": usage, "elapsedMs": int(reply.elapsed * 1000), "textHash": digest(reply.text.encode())})
        observe_panel(active_alias["value"], last_response["model"])
        if reply.finish_reason in ("length", "max_tokens", "max_output_tokens"):
            reply.outcome = providers.EMPTY
            reply.text = ""
        return reply
    providers.call = send
    original_model = client.call_model
    cache_dir = run / "cache"; cache_dir.mkdir(exist_ok=True)
    def call_model(alias, prompt, **kwargs):
        # Keep the upstream prompt's current-date guidance accurate and frozen for replay.
        date = spec["createdAt"][:7].split("-")
        prompt = prompt.replace("2026 年 5 月", f"{date[0]} 年 {int(date[1])} 月")
        if alias not in profiles:
            raise StopRun("Legacy model aliases are unsupported by this bounded bridge.")
        if profiles[alias].get("transport", "httpx") != "httpx" or profiles[alias].get("api") not in providers.DIALECTS:
            raise RuntimeError("Unsupported bounded provider route; use a unified HTTPX profile.")
        params = {key: value for key, value in kwargs.items() if key not in ("_config", "attempts", "timeout")}
        params["max_tokens"] = min(int(params.get("max_tokens", spec["maxTokens"])), spec["maxTokens"])
        key = digest(encoded({"configHash": metadata["configHash"], "alias": alias, "prompt": prompt, "params": params}))
        cached = cache_dir / f"{key}.json"
        if cached.exists():
            value = json.loads(cached.read_text())
            completed = next((e for e in events if e["kind"] == "response_cached" and e["data"]["key"] == key), None)
            if value.get("key") != key or not completed or digest(cached.read_bytes()) != completed["data"]["hash"]:
                raise StopRun("Cached response integrity check failed.")
            emit({"type": "progress", "requests": calls, "maxRequests": spec["maxRequests"], "stage": "cached_response"})
            return value["text"]
        if time.time() >= deadline:
            raise StopRun("Generation time budget exhausted.")
        active_alias["value"] = alias
        text = original_model(alias, prompt, _config=cfg, attempts=1, timeout=min(spec["requestTimeoutSeconds"], max(1, deadline-time.time())), **params)
        if text:
            if len(text.encode()) > 1024 * 1024:
                raise StopRun("Model response exceeded 1 MiB.")
            atomic(cached, {"key": key, "text": text})
            log("response_cached", {"key": key, "hash": digest(cached.read_bytes())})
        return text
    client.call_model = call_model
    # Read the exact knowledge snapshot approved for this run.
    b_library.KNOWLEDGE_BASE_DIR = run / "knowledge_base"
    from idea_forge import forge
    from idea_forge import freshness
    forge.step2_5_freshness_refresh = lambda items, enable_arxiv=True: freshness.step2_5_freshness_refresh(items, enable_arxiv=False)
    # Freeze resource descriptions for cache-safe replay instead of probing hardware on each retry.
    class Resources:
        def describe(self):
            return spec["resourceDescription"]
    forge.resource_profile.load = lambda: Resources()
    seed = {"seed_key": spec["seedHash"], "title": spec["topic"], "url": spec["sourceUrl"], "llm_judgment": "核心 insight: " + " ".join(spec["signal"].splitlines())}
    result = forge.run_idea_forge([seed], b_ids=[spec["direction"]], checkpoint_path=str(run / "forge.json"))
    emit({"type": "complete", "summary": result["summary"], "requests": calls})

if __name__ == "__main__":
    try:
        with redirect_stdout(Quiet()), redirect_stderr(Quiet()):
            action, root = sys.argv[1:3]
            data = json.load(sys.stdin)
            if action == "inspect":
                _, _, meta, *_ = prepare(root, data.get("modelPanel"))
                emit(meta)
            elif action == "generate":
                signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(StopRun("Generation paused/cancelled.")))
                generate(root, data)
            else:
                raise StopRun("Unknown bridge action.")
    except BaseException as error:
        # Do not expose provider errors, response bodies, credentials or endpoint URLs.
        message = str(error) if isinstance(error, StopRun) else f"Backend {type(error).__name__}; inspect configuration/dependencies."
        emit({"type": "error", "message": message})
        sys.exit(2)
