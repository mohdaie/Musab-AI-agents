"""An independent agent: its own persona, skills, model and memory.

Every agent runs its own loop against the shared bus. Nothing routes
messages for it: it reads what is addressed to it, thinks with its own
DeepSeek call, and posts replies straight back to the bus, where the
other agents (or the human) pick them up.
"""
from __future__ import annotations

import json
import re
import sys
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

import yaml

from .config import Config
from .llm import LLM
from .store import SHARED, Message, Store

NAME_RE = re.compile(r"^[a-z][a-z0-9_-]{0,31}$")
MENTION_RE = re.compile(r"@([a-z][a-z0-9_-]{0,31})", re.I)


# --------------------------------------------------------------------- specs
@dataclass
class AgentSpec:
    name: str
    role: str
    persona: str = ""
    skills: list[str] = field(default_factory=list)
    model: str | None = None
    thinking: str = "high"          # off | low | high | max
    enabled: bool = True

    @classmethod
    def from_file(cls, path: Path) -> "AgentSpec":
        d = yaml.safe_load(path.read_text()) or {}
        name = str(d.get("name") or path.stem).lower()
        if not NAME_RE.match(name):
            raise ValueError(f"{path}: invalid agent name {name!r}")
        return cls(
            name=name,
            role=str(d.get("role", "")).strip(),
            persona=str(d.get("persona", "")).strip(),
            skills=[str(s) for s in d.get("skills", [])],
            model=d.get("model"),
            thinking=str(d.get("thinking", "high")),
            enabled=bool(d.get("enabled", True)),
        )


def load_roster(agents_dir: Path) -> dict[str, AgentSpec]:
    roster: dict[str, AgentSpec] = {}
    for p in sorted(agents_dir.glob("*.y*ml")):
        spec = AgentSpec.from_file(p)
        if spec.enabled:
            roster[spec.name] = spec
    return roster


def load_skill(skills_dir: Path, skill: str) -> str:
    p = skills_dir / f"{skill}.md"
    return p.read_text().strip() if p.exists() else f"(skill file {p.name} not found)"


# --------------------------------------------------------------------- tools
TOOLS = [
    {"type": "function", "function": {
        "name": "send_message",
        "description": "Send a message on the team bus to one or more agents (or 'user', or 'all'). "
                       "Use it to ask another specialist something or hand work off.",
        "parameters": {"type": "object", "properties": {
            "to": {"type": "array", "items": {"type": "string"},
                   "description": "Recipient names, e.g. ['charles'] or ['all']"},
            "content": {"type": "string"}},
            "required": ["to", "content"]}}},
    {"type": "function", "function": {
        "name": "remember",
        "description": "Save a durable fact to your long-term memory (survives restarts). "
                       "Set shared=true to save it to team memory every agent can read.",
        "parameters": {"type": "object", "properties": {
            "content": {"type": "string"},
            "shared": {"type": "boolean", "default": False}},
            "required": ["content"]}}},
    {"type": "function", "function": {
        "name": "recall",
        "description": "Search your long-term memory and team memory by keywords.",
        "parameters": {"type": "object", "properties": {
            "query": {"type": "string"}}, "required": ["query"]}}},
    {"type": "function", "function": {
        "name": "forget",
        "description": "Delete a memory by id (your own or team memory).",
        "parameters": {"type": "object", "properties": {
            "memory_id": {"type": "integer"}}, "required": ["memory_id"]}}},
    {"type": "function", "function": {
        "name": "list_agents",
        "description": "List the agents currently on the team and their roles.",
        "parameters": {"type": "object", "properties": {}}}},
]


# --------------------------------------------------------------------- agent
class Agent:
    def __init__(self, spec: AgentSpec, cfg: Config, llm: LLM, store: Store | None = None,
                 log=print):
        self.spec = spec
        self.cfg = cfg
        self.llm = llm
        self.store = store or Store(cfg.db_path)
        self.log = log

    @property
    def name(self) -> str:
        return self.spec.name

    def roster(self) -> dict[str, AgentSpec]:
        # Re-read every time so agents added/removed at runtime are seen.
        return load_roster(self.cfg.agents_dir)

    # ---------------------------------------------------------- decide
    def should_react(self, msg: Message, roster: dict[str, AgentSpec]) -> bool:
        if msg.sender == self.name or not msg.is_for(self.name):
            return False
        from_agent = msg.sender in roster
        if self.name in msg.recipients:
            # Directly addressed. Agent-to-agent chains stop at max_hops.
            return not from_agent or msg.hop < self.cfg.max_hops
        # Broadcast ("all"): answer humans; agent broadcasts are FYI only.
        return not from_agent

    # ---------------------------------------------------------- prompt
    def system_prompt(self, msg: Message, roster: dict[str, AgentSpec]) -> str:
        s = self.spec
        team = "\n".join(f"- @{a.name}: {a.role}" for a in roster.values() if a.name != s.name)
        skills = "\n\n".join(f"### Skill: {k}\n{load_skill(self.cfg.skills_dir, k)}"
                             for k in s.skills) or "(no extra skills)"
        owners = [s.name, SHARED]
        seen, mems = set(), []
        for m in self.store.recall(owners, msg.content, 6) + self.store.recall(owners, "", 6):
            if m.id not in seen:
                seen.add(m.id)
                tag = "team" if m.owner == SHARED else "own"
                mems.append(f"- [{m.id}|{tag}] {m.content}")
        memory = "\n".join(mems) or "(nothing saved yet)"
        return f"""You are {s.name}, {s.role}.
{s.persona}

## Your team (independent agents, no boss, no router)
{team or "(you are alone right now)"}
The human is "user".

## How messaging works
- Your final answer is posted on the bus to whoever messaged you.
- Write @name in your answer to pull that agent into the conversation; they will receive it and reply to you directly.
- Or call send_message to message someone separately.
- Stay inside your own expertise. If something belongs to another agent's skillset, hand it to them with @name instead of guessing.
- Challenge other agents when you think they are wrong; give evidence.
- If you have nothing useful to add, answer exactly PASS (nothing is posted).
- Be concise.

## Your skills
{skills}

## Your persistent memory (use remember/recall/forget tools to manage it)
{memory}
"""

    def user_prompt(self, msg: Message) -> str:
        history = [m for m in self.store.thread(msg.thread_id, 30) if m.id < msg.id]
        lines = [f"[#{m.id}] {m.sender} -> {', '.join(m.recipients)}: {m.content}" for m in history]
        return ("Conversation so far (oldest first):\n" + ("\n".join(lines) or "(new thread)") +
                f"\n\nNew message for you:\n[#{msg.id}] {msg.sender} -> {', '.join(msg.recipients)}"
                f" (hop {msg.hop}): {msg.content}")

    # ---------------------------------------------------------- act
    def run_tool(self, name: str, args: dict, msg: Message, roster: dict[str, AgentSpec]) -> str:
        if name == "send_message":
            to = args.get("to") or []
            if isinstance(to, str):
                to = [t for t in re.split(r"[,\s]+", to) if t]
            to = [t.lower().lstrip("@") for t in to]
            bad = [t for t in to if t not in roster and t not in ("user", "all")]
            if bad:
                return f"Unknown recipient(s): {bad}. Known: {list(roster)} + user, all"
            m = self.store.post(self.name, to, args.get("content", ""), parent=msg)
            return f"sent as message #{m.id}"
        if name == "remember":
            owner = SHARED if args.get("shared") else self.name
            m = self.store.remember(owner, args.get("content", ""))
            return f"saved memory #{m.id} ({'team' if owner == SHARED else 'own'})"
        if name == "recall":
            hits = self.store.recall([self.name, SHARED], args.get("query", ""), 10)
            return "\n".join(f"[{m.id}|{'team' if m.owner == SHARED else 'own'}] {m.content}"
                             for m in hits) or "no matches"
        if name == "forget":
            ok = self.store.forget([self.name, SHARED], int(args.get("memory_id", -1)))
            return "deleted" if ok else "no such memory"
        if name == "list_agents":
            return "\n".join(f"{a.name}: {a.role} (skills: {', '.join(a.skills)})"
                             for a in roster.values())
        return f"unknown tool {name}"

    def handle(self, msg: Message) -> Message | None:
        roster = self.roster()
        messages: list[dict] = [
            {"role": "system", "content": self.system_prompt(msg, roster)},
            {"role": "user", "content": self.user_prompt(msg)},
        ]
        model = self.spec.model or self.cfg.model
        reply = ""
        for _ in range(self.cfg.max_tool_steps):
            out = self.llm.chat(model=model, messages=messages, tools=TOOLS,
                                thinking=self.spec.thinking)
            messages.append(out)
            calls = out.get("tool_calls") or []
            if not calls:
                reply = (out.get("content") or "").strip()
                break
            for c in calls:
                fn = c["function"]
                try:
                    args = json.loads(fn.get("arguments") or "{}")
                    result = self.run_tool(fn["name"], args, msg, roster)
                except Exception as e:  # report tool errors back to the model
                    result = f"tool error: {e}"
                messages.append({"role": "tool", "tool_call_id": c["id"], "content": result})
        else:
            reply = (messages[-1].get("content") or "").strip() if messages[-1]["role"] == "assistant" else ""

        if not reply or reply.upper().rstrip(".") == "PASS":
            return None
        mentions = {m.lower() for m in MENTION_RE.findall(reply)} & set(roster)
        to = {msg.sender} | (mentions - {self.name})
        return self.store.post(self.name, sorted(to), reply, parent=msg)

    # ---------------------------------------------------------- loop
    def poll_once(self) -> int:
        """Process new bus messages. Returns how many this agent reacted to."""
        cursor = self.store.get_cursor(self.name)
        if cursor is None:  # new agent joins from "now", it doesn't replay history
            cursor = self.store.last_id()
            self.store.set_cursor(self.name, cursor)
        handled = 0
        for msg in self.store.messages_after(cursor):
            roster = self.roster()
            if self.name in roster and self.should_react(msg, roster):
                try:
                    out = self.handle(msg)
                    handled += 1
                    if out:
                        self.log(f"[{self.name}] replied #{out.id} -> {', '.join(out.recipients)}")
                except Exception as e:
                    print(f"[{self.name}] error on #{msg.id}: {e}", file=sys.stderr)
            self.store.set_cursor(self.name, msg.id)
        return handled

    def run_forever(self, stop: threading.Event | None = None) -> None:
        stop = stop or threading.Event()
        self.log(f"[{self.name}] online ({self.spec.model or self.cfg.model}, thinking={self.spec.thinking})")
        while not stop.is_set():
            if not self.poll_once():
                stop.wait(self.cfg.poll_seconds)
