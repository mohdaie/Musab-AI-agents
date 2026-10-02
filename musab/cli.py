"""Command line: musab <command>."""
from __future__ import annotations

import argparse
import os
import re
import signal
import sys
import threading
from datetime import datetime

from .agent import NAME_RE, Agent, load_roster
from .config import Config
from .llm import DeepSeek
from .store import SHARED, Message, Store


def fmt(m: Message) -> str:
    t = datetime.fromtimestamp(m.created_at).strftime("%H:%M:%S")
    return f"\n[{t} #{m.id} t{m.thread_id}] {m.sender} -> {', '.join(m.recipients)}\n{m.content}"


def parse_to(text: str, default: list[str]) -> tuple[list[str], str]:
    """'@zu @charles why is X slow' -> (['zu','charles'], 'why is X slow')."""
    to = []
    while (m := re.match(r"\s*@([\w-]+)\s*", text)):
        to.append(m.group(1).lower())
        text = text[m.end():]
    return (to or default), text.strip()


def cmd_agents(cfg: Config, a) -> None:
    roster = load_roster(cfg.agents_dir)
    if not roster:
        print("No agents. Create one: musab new-agent <name> --role '...'")
    for s in roster.values():
        print(f"@{s.name:<12} {s.role}\n{'':14}skills: {', '.join(s.skills) or '-'} | "
              f"model: {s.model or cfg.model} | thinking: {s.thinking}")


def cmd_new_agent(cfg: Config, a) -> None:
    name = a.name.lower()
    if not NAME_RE.match(name):
        sys.exit("Name must be lowercase letters/digits/-/_ and start with a letter")
    path = cfg.agents_dir / f"{name}.yaml"
    if path.exists():
        sys.exit(f"{path} already exists")
    skills = [s.strip() for s in (a.skills or "").split(",") if s.strip()]
    cfg.agents_dir.mkdir(parents=True, exist_ok=True)
    cfg.skills_dir.mkdir(parents=True, exist_ok=True)
    skill_lines = "".join(f"  - {s}\n" for s in skills) or "  []\n"
    path.write_text(
        f"name: {name}\nrole: {a.role}\n# model: deepseek-v4-pro   # optional per-agent override\n"
        f"thinking: {a.thinking}           # off | low | high | max\n"
        f"skills:\n{skill_lines}persona: |\n  Describe how {name} thinks and talks here.\n")
    print(f"created {path.relative_to(cfg.home)}")
    for s in skills:
        sp = cfg.skills_dir / f"{s}.md"
        if not sp.exists():
            sp.write_text(f"# {s}\n\nWrite what this skill knows and how to apply it.\n")
            print(f"created {sp.relative_to(cfg.home)} (stub, fill it in)")
    print("Running agents pick it up on the next message, or restart `musab run`.")


def cmd_run(cfg: Config, a) -> None:
    roster = load_roster(cfg.agents_dir)
    only = {n.strip().lower() for n in (a.only or "").split(",") if n.strip()}
    specs = [s for s in roster.values() if not only or s.name in only]
    if not specs:
        sys.exit("No agents to run.")
    try:
        llm = DeepSeek(cfg.api_key, cfg.base_url)
    except RuntimeError as e:
        sys.exit(str(e))
    stop = threading.Event()
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    threads = []
    for s in specs:  # one independent loop + own DB connection per agent
        ag = Agent(s, cfg, llm)
        t = threading.Thread(target=ag.run_forever, args=(stop,), name=s.name, daemon=True)
        t.start()
        threads.append(t)
    known = {s.name for s in specs}
    print(f"{len(specs)} agent(s) running. Ctrl+C to stop. Talk to them with `musab chat`.")
    while not stop.is_set():  # start agents that were added while running
        stop.wait(10)
        if a.only:
            continue
        for s in load_roster(cfg.agents_dir).values():
            if s.name not in known:
                known.add(s.name)
                t = threading.Thread(target=Agent(s, cfg, llm).run_forever, args=(stop,),
                                     name=s.name, daemon=True)
                t.start()
                threads.append(t)
    for t in threads:
        t.join(timeout=5)


def cmd_say(cfg: Config, a) -> None:
    store = Store(cfg.db_path)
    to, text = parse_to(" ".join(a.text), a.to.split(","))
    m = store.post(a.as_name, to, text)
    print(f"posted #{m.id} -> {', '.join(m.recipients)}")


def cmd_chat(cfg: Config, a) -> None:
    store = Store(cfg.db_path)
    tail = Store(cfg.db_path)
    stop = threading.Event()
    last = [tail.last_id()]

    def follow():
        while not stop.is_set():
            for m in tail.messages_after(last[0]):
                last[0] = m.id
                if m.sender != a.as_name:
                    print(fmt(m), flush=True)
            stop.wait(1)

    threading.Thread(target=follow, daemon=True).start()
    print("Chat started. Type a message (sent to all), or start with @name to address agents. "
          "Ctrl+D to quit.")
    try:
        for line in sys.stdin:
            if not line.strip():
                continue
            to, text = parse_to(line, ["all"])
            store.post(a.as_name, to, text)
    except KeyboardInterrupt:
        pass
    stop.set()


def cmd_log(cfg: Config, a) -> None:
    store = Store(cfg.db_path)
    msgs = store.thread(a.thread, a.limit) if a.thread else store.recent(a.limit)
    for m in msgs:
        print(fmt(m))


def cmd_memory(cfg: Config, a) -> None:
    store = Store(cfg.db_path)
    owner = SHARED if a.agent in ("team", "shared") else a.agent.lower()
    if a.add:
        m = store.remember(owner, a.add)
        print(f"saved #{m.id}")
        return
    if a.forget:
        print("deleted" if store.forget([owner], a.forget) else "not found")
        return
    for m in store.recall([owner], a.search or "", a.limit):
        print(f"[{m.id}] {m.content}")


def cmd_serve(cfg: Config, a) -> None:
    from .server import serve
    serve(cfg, a.host, a.port, a.token or os.environ.get("MUSAB_UI_TOKEN", ""))


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(prog="musab", description="Dynamic team of independent DeepSeek agents")
    p.add_argument("--home", default=".", help="project folder with agents/ and skills/")
    p.add_argument("--team", help="use a team made in the web UI (folder name in data/teams/)")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("agents", help="list agents")

    n = sub.add_parser("new-agent", help="scaffold a new agent")
    n.add_argument("name")
    n.add_argument("--role", required=True)
    n.add_argument("--skills", help="comma separated skill names")
    n.add_argument("--thinking", default="high", choices=["off", "low", "high", "max"])

    r = sub.add_parser("run", help="start agents (each runs its own independent loop)")
    r.add_argument("--only", help="comma separated agent names (e.g. run each in its own terminal)")

    s = sub.add_parser("say", help="post one message to the bus")
    s.add_argument("text", nargs="+")
    s.add_argument("--to", default="all")
    s.add_argument("--as", dest="as_name", default="user")

    c = sub.add_parser("chat", help="interactive chat with the team")
    c.add_argument("--as", dest="as_name", default="user")

    lg = sub.add_parser("log", help="show bus history")
    lg.add_argument("--thread", type=int)
    lg.add_argument("--limit", type=int, default=50)

    m = sub.add_parser("memory", help="view/edit an agent's memory ('team' for shared)")
    m.add_argument("agent")
    m.add_argument("--search")
    m.add_argument("--add")
    m.add_argument("--forget", type=int)
    m.add_argument("--limit", type=int, default=50)

    sv = sub.add_parser("serve", help="web app (PWA): create teams and chat with them")
    sv.add_argument("--host", default="127.0.0.1",
                    help="0.0.0.0 to open it from your phone on the same network")
    sv.add_argument("--port", type=int, default=8765)
    sv.add_argument("--token", help="require this access token (or set MUSAB_UI_TOKEN)")

    a = p.parse_args(argv)
    cfg = Config.load(a.home)
    if a.team:
        try:
            cfg = cfg.for_team(a.team)
        except (ValueError, FileNotFoundError) as e:
            sys.exit(str(e))
    {"agents": cmd_agents, "new-agent": cmd_new_agent, "run": cmd_run, "say": cmd_say,
     "chat": cmd_chat, "log": cmd_log, "memory": cmd_memory, "serve": cmd_serve}[a.cmd](cfg, a)


if __name__ == "__main__":
    main()
