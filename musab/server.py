"""Web UI (installable PWA) + JSON API, and the agents of every team it manages.

`musab serve` starts one process that:
- serves the app in musab/web/ (create a team, then chat with it),
- runs every agent of every team in data/teams/<team>/, each in its own
  independent loop exactly like `musab run`, and picks up new teams/agents.

Each team is a folder: team.yaml (name, style), agents/*.yaml and its own
musab.db (bus + memory). Skills in skills/ are shared by all teams.
Stdlib only (http.server), no extra dependencies.
"""
from __future__ import annotations

import json
import mimetypes
import re
import shutil
import sys
import threading
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import yaml

from .agent import NAME_RE, Agent, AgentSpec, load_roster
from .config import TEAM_RE, Config
from .llm import LLM, DeepSeek
from .store import Message, Store

WEB_DIR = Path(__file__).with_name("web")
STYLES = ("work", "friends")
RESERVED = {"user", "all", "system"}
MAX_AGENTS = 12


class ApiError(Exception):
    def __init__(self, status: int, msg: str):
        super().__init__(msg)
        self.status = status


def slugify(text: str, maxlen: int) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:maxlen].strip("-")
    return s


def msg_json(m: Message) -> dict:
    return {"id": m.id, "thread_id": m.thread_id, "parent_id": m.parent_id, "sender": m.sender,
            "recipients": m.recipients, "content": m.content, "hop": m.hop,
            "created_at": m.created_at}


# --------------------------------------------------------------------- runtime
class UIAgent(Agent):
    """An Agent that reports when it is thinking and posts its errors to the chat."""

    def __init__(self, *a, busy: set[str], **kw):
        super().__init__(*a, **kw)
        self.busy = busy

    def handle(self, msg: Message) -> Message | None:
        self.busy.add(self.name)
        try:
            return super().handle(msg)
        except Exception as e:  # show it in the chat instead of only on stderr
            print(f"[{self.name}] error on #{msg.id}: {e}", file=sys.stderr)
            self.store.post("system", ["user"], f"{self.name} couldn't reply: {e}", parent=msg)
            return None
        finally:
            self.busy.discard(self.name)


class TeamRunner:
    """Runs the agents of one team, each in its own thread."""

    def __init__(self, cfg: Config, llm: LLM | None):
        self.cfg = cfg
        self.llm = llm
        self.stop = threading.Event()
        self.busy: set[str] = set()
        self.known: set[str] = set()
        self.threads: list[threading.Thread] = []

    def sync(self) -> None:
        if self.llm is None or self.stop.is_set():
            return
        for spec in load_roster(self.cfg.agents_dir).values():
            if spec.name in self.known:
                continue
            self.known.add(spec.name)
            ag = UIAgent(spec, self.cfg, self.llm, busy=self.busy, log=lambda *_: None)
            if ag.store.get_cursor(spec.name) is None:  # joins from now, sees the next message
                ag.store.set_cursor(spec.name, ag.store.last_id())
            t = threading.Thread(target=ag.run_forever, args=(self.stop,),
                                 name=f"{self.cfg.agents_dir.parent.name}/{spec.name}", daemon=True)
            t.start()
            self.threads.append(t)

    def shutdown(self, timeout: float = 2) -> None:
        self.stop.set()
        for t in self.threads:
            t.join(timeout)


class Hub:
    """Teams on disk + their running agents. All API logic lives here (testable without HTTP)."""

    def __init__(self, cfg: Config, llm: LLM | None = None, llm_error: str = ""):
        self.cfg = cfg
        self.llm = llm
        self.llm_error = llm_error
        self.runners: dict[str, TeamRunner] = {}
        self.lock = threading.RLock()
        self.cfg.teams_dir.mkdir(parents=True, exist_ok=True)
        self._stop = threading.Event()

    # ---------------------------------------------------------------- runtime
    def team_ids(self) -> list[str]:
        return sorted(p.name for p in self.cfg.teams_dir.iterdir()
                      if p.is_dir() and TEAM_RE.match(p.name) and (p / "team.yaml").exists())

    def sync(self) -> None:
        with self.lock:
            ids = set(self.team_ids())
            for tid in ids - set(self.runners):
                self.runners[tid] = TeamRunner(self.cfg.for_team(tid), self.llm)
            for tid in set(self.runners) - ids:
                self.runners.pop(tid).shutdown(0)
            for r in self.runners.values():
                r.sync()

    def watch(self, every: float = 5) -> None:
        """Pick up teams/agents added on disk (or by another process) while running."""
        def loop():
            while not self._stop.wait(every):
                try:
                    self.sync()
                except Exception as e:
                    print(f"[serve] sync error: {e}", file=sys.stderr)
        threading.Thread(target=loop, name="hub-watch", daemon=True).start()

    def shutdown(self) -> None:
        self._stop.set()
        with self.lock:
            for r in self.runners.values():
                r.shutdown()

    # ---------------------------------------------------------------- helpers
    def team_cfg(self, tid: str) -> Config:
        try:
            return self.cfg.for_team(tid)
        except (ValueError, FileNotFoundError):
            raise ApiError(404, "team not found")

    def store(self, cfg: Config) -> Store:
        return Store(cfg.db_path)

    def team_json(self, tid: str) -> dict:
        cfg = self.team_cfg(tid)
        meta = yaml.safe_load((cfg.teams_dir / tid / "team.yaml").read_text()) or {}
        roster = load_roster(cfg.agents_dir)
        last = None
        if cfg.db_path.exists():
            st = self.store(cfg)
            try:
                rec = st.recent(1)
                last = msg_json(rec[0]) if rec else None
            finally:
                st.close()
        return {"id": tid, "name": cfg.team_name, "style": cfg.team_style,
                "created_at": meta.get("created_at"), "last_message": last,
                "agents": [{"name": s.name, "role": s.role, "persona": s.persona}
                           for s in roster.values()]}

    # ---------------------------------------------------------------- API
    def status(self) -> dict:
        return {"llm": self.llm is not None, "error": self.llm_error, "model": self.cfg.model}

    def list_teams(self) -> list[dict]:
        teams = [self.team_json(t) for t in self.team_ids()]
        teams.sort(key=lambda t: -((t["last_message"] or {}).get("created_at")
                                   or t["created_at"] or 0))
        return teams

    def create_team(self, body: dict) -> dict:
        name = str(body.get("name") or "").strip()[:60]
        style = str(body.get("style") or "work")
        agents = body.get("agents")
        if not name:
            raise ApiError(400, "Give the team a name")
        if style not in STYLES:
            raise ApiError(400, f"style must be one of {STYLES}")
        if not isinstance(agents, list) or not 1 <= len(agents) <= MAX_AGENTS:
            raise ApiError(400, f"A team needs 1 to {MAX_AGENTS} agents")

        specs, seen = [], set()
        for i, a in enumerate(agents, 1):
            if not isinstance(a, dict):
                raise ApiError(400, f"Agent #{i} is invalid")
            role = str(a.get("role") or "").strip()[:120]
            about = str(a.get("about") or "").strip()[:2000]
            aname = slugify(str(a.get("name") or ""), 32).replace("-", "_") or f"agent{i}"
            if not aname[0].isalpha():
                aname = f"a{aname}"[:32]
            if not role:
                raise ApiError(400, f"Agent #{i} needs a designation")
            if not NAME_RE.match(aname) or aname in RESERVED:
                raise ApiError(400, f"Agent #{i}: '{aname}' can't be used as a name")
            if aname in seen:
                raise ApiError(400, f"Two agents are called '{aname}'")
            seen.add(aname)
            specs.append(AgentSpec(
                name=aname, role=role, persona=about,
                skills=["critical-review"] if style == "work" else [],
                thinking="high" if style == "work" else "low"))

        with self.lock:
            base = slugify(name, 32) or "team"
            tid, n = base, 2
            while (self.cfg.teams_dir / tid).exists():
                tid, n = f"{base}-{n}", n + 1
            tdir = self.cfg.teams_dir / tid
            (tdir / "agents").mkdir(parents=True)
            (tdir / "team.yaml").write_text(yaml.safe_dump(
                {"name": name, "style": style, "created_at": time.time()},
                sort_keys=False, allow_unicode=True))
            for s in specs:
                (tdir / "agents" / f"{s.name}.yaml").write_text(yaml.safe_dump(
                    {"name": s.name, "role": s.role, "thinking": s.thinking,
                     "skills": s.skills, "persona": s.persona},
                    sort_keys=False, allow_unicode=True))
            Store(tdir / "musab.db").close()
        self.sync()
        return self.team_json(tid)

    def delete_team(self, tid: str) -> dict:
        self.team_cfg(tid)  # 404 if missing
        with self.lock:
            r = self.runners.pop(tid, None)
            if r:
                r.shutdown()
            shutil.rmtree(self.cfg.teams_dir / tid, ignore_errors=True)
        return {"deleted": tid}

    def messages(self, tid: str, after: int = 0, limit: int = 200) -> dict:
        cfg = self.team_cfg(tid)
        st = self.store(cfg)
        try:
            msgs = st.messages_after(after, limit) if after else st.recent(limit)
        finally:
            st.close()
        r = self.runners.get(tid)
        return {"messages": [msg_json(m) for m in msgs],
                "busy": sorted(r.busy) if r else []}

    def post(self, tid: str, body: dict) -> dict:
        from .cli import parse_to
        cfg = self.team_cfg(tid)
        content = str(body.get("content") or "")[:8000]
        to, text = parse_to(content, ["all"])
        if not text:
            raise ApiError(400, "Message is empty")
        roster = load_roster(cfg.agents_dir)
        unknown = [t for t in to if t not in roster and t != "all"]
        if unknown:
            raise ApiError(400, f"No one called @{unknown[0]} in this team")
        st = self.store(cfg)
        try:
            m = st.post("user", to, text)
        finally:
            st.close()
        return msg_json(m)


# --------------------------------------------------------------------- HTTP
def make_handler(hub: Hub, token: str = "", allowed_hosts: set[str] | None = None):
    class Handler(BaseHTTPRequestHandler):
        server_version = "musab"

        def log_message(self, *a):  # keep the console for agent output
            pass

        # ------------------------------------------------------------ plumbing
        def send(self, status: int, body: bytes, ctype: str, extra: dict | None = None):
            self.send_response(status)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("X-Content-Type-Options", "nosniff")
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def json(self, status: int, data) -> None:
            self.send(status, json.dumps(data).encode(), "application/json",
                      {"Cache-Control": "no-store"})

        def body(self) -> dict:
            if "application/json" not in (self.headers.get("Content-Type") or ""):
                raise ApiError(415, "expected application/json")
            n = int(self.headers.get("Content-Length") or 0)
            if n > 256_000:
                raise ApiError(413, "request too large")
            try:
                data = json.loads(self.rfile.read(n) or b"{}")
            except ValueError:
                raise ApiError(400, "invalid JSON")
            if not isinstance(data, dict):
                raise ApiError(400, "expected a JSON object")
            return data

        def host_ok(self) -> bool:
            if not allowed_hosts:
                return True
            host = (self.headers.get("Host") or "").rsplit(":", 1)[0].strip("[]").lower()
            return host in allowed_hosts

        # ------------------------------------------------------------ routes
        def do_GET(self):
            self.route("GET")

        def do_HEAD(self):
            self.route("GET")

        def do_POST(self):
            self.route("POST")

        def do_DELETE(self):
            self.route("DELETE")

        def route(self, method: str) -> None:
            url = urlsplit(self.path)
            path = url.path
            if not self.host_ok():  # DNS-rebinding guard when bound to localhost
                return self.json(403, {"error": "host not allowed"})
            if path.startswith("/api/"):
                try:
                    if token and self.headers.get("Authorization") != f"Bearer {token}":
                        raise ApiError(401, "token required")
                    return self.json(200, self.api(method, path, parse_qs(url.query)))
                except ApiError as e:
                    return self.json(e.status, {"error": str(e)})
                except Exception as e:
                    print(f"[serve] {method} {path}: {e!r}", file=sys.stderr)
                    return self.json(500, {"error": "server error"})
            if method != "GET":
                return self.json(405, {"error": "method not allowed"})
            self.static(path)

        def api(self, method: str, path: str, q: dict):
            parts = path.strip("/").split("/")[1:]  # drop "api"
            if parts == ["status"] and method == "GET":
                return hub.status()
            if parts == ["teams"]:
                if method == "GET":
                    return hub.list_teams()
                if method == "POST":
                    return hub.create_team(self.body())
            if len(parts) == 2 and parts[0] == "teams":
                if method == "GET":
                    return hub.team_json(parts[1])
                if method == "DELETE":
                    return hub.delete_team(parts[1])
            if len(parts) == 3 and parts[0] == "teams" and parts[2] == "messages":
                if method == "GET":
                    try:
                        after = int(q.get("after", ["0"])[0])
                        limit = max(1, min(500, int(q.get("limit", ["200"])[0])))
                    except ValueError:
                        raise ApiError(400, "after/limit must be numbers")
                    return hub.messages(parts[1], after, limit)
                if method == "POST":
                    return hub.post(parts[1], self.body())
            raise ApiError(404, "not found")

        def static(self, path: str) -> None:
            rel = "index.html" if path in ("", "/") else path.lstrip("/")
            f = (WEB_DIR / rel).resolve()
            if WEB_DIR.resolve() not in f.parents or not f.is_file():
                f = WEB_DIR / "index.html"  # single-page app fallback
            ctype = {".webmanifest": "application/manifest+json", ".js": "text/javascript",
                     ".svg": "image/svg+xml"}.get(f.suffix) or \
                mimetypes.guess_type(f.name)[0] or "application/octet-stream"
            if ctype.startswith("text/") or ctype.endswith(("json", "javascript")):
                ctype += "; charset=utf-8"
            extra = {"Cache-Control": "no-cache"}
            if f.name == "sw.js":
                extra["Service-Worker-Allowed"] = "/"
            self.send(200, f.read_bytes(), ctype, extra)

    return Handler


def serve(cfg: Config, host: str = "127.0.0.1", port: int = 8765, token: str = "",
          llm: LLM | None = None) -> None:
    err = ""
    if llm is None:
        try:
            llm = DeepSeek(cfg.api_key, cfg.base_url)
        except RuntimeError as e:
            err = str(e)
    hub = Hub(cfg, llm, err)
    hub.sync()
    hub.watch()
    local = host in ("127.0.0.1", "localhost", "::1")
    allowed = {"localhost", "127.0.0.1", "::1"} if local else None
    httpd = ThreadingHTTPServer((host, port), make_handler(hub, token, allowed))
    httpd.daemon_threads = True
    shown = "localhost" if local else host
    print(f"Musab UI on http://{shown}:{httpd.server_port}/"
          f"{'?token=' + token if token else ''}  (Ctrl+C to stop)")
    if err:
        print(f"WARNING: agents can't reply: {err}", file=sys.stderr)
    if not local and not token:
        print("WARNING: listening on the network without --token; anyone who can reach this "
              "port can chat with your agents and use your DeepSeek credits.", file=sys.stderr)
    print(f"{len(hub.runners)} team(s) loaded from {cfg.teams_dir}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
        hub.shutdown()
