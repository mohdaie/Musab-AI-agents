from __future__ import annotations

import os
import re
from dataclasses import dataclass, replace
from pathlib import Path

import yaml

TEAM_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,39}$")


def load_dotenv(path: Path) -> None:
    """Tiny .env loader: KEY=VALUE lines, existing env vars win."""
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


@dataclass
class Config:
    home: Path
    api_key: str
    base_url: str
    model: str
    db_path: Path
    max_hops: int
    poll_seconds: float
    max_tool_steps: int
    teams_dir: Path | None = None
    agents_dir: Path | None = None   # defaults to <home>/agents
    skills_dir: Path | None = None   # defaults to <home>/skills (shared by all teams)
    team_name: str = ""
    team_style: str = "work"         # work | friends

    def __post_init__(self):
        self.teams_dir = self.teams_dir or self.home / "data" / "teams"
        self.agents_dir = self.agents_dir or self.home / "agents"
        self.skills_dir = self.skills_dir or self.home / "skills"

    def for_team(self, slug: str) -> "Config":
        """Config for a team made in the web UI: its own agents/ folder and database."""
        if not TEAM_RE.match(slug):
            raise ValueError(f"invalid team id {slug!r}")
        d = self.teams_dir / slug
        if not d.is_dir():
            raise FileNotFoundError(f"no team {slug!r} in {self.teams_dir}")
        meta = yaml.safe_load((d / "team.yaml").read_text()) if (d / "team.yaml").exists() else {}
        meta = meta or {}
        return replace(self, agents_dir=d / "agents", db_path=d / "musab.db",
                       team_name=str(meta.get("name") or slug),
                       team_style=str(meta.get("style") or "work"))

    @classmethod
    def load(cls, home: str | Path = ".") -> "Config":
        home = Path(home).resolve()
        load_dotenv(home / ".env")
        e = os.environ.get
        db = Path(e("MUSAB_DB", "data/musab.db"))
        teams = Path(e("MUSAB_TEAMS_DIR", "data/teams"))
        return cls(
            home=home,
            api_key=e("DEEPSEEK_API_KEY", ""),
            base_url=e("DEEPSEEK_BASE_URL", "https://api.deepseek.com"),
            model=e("DEEPSEEK_MODEL", "deepseek-v4-pro"),
            db_path=db if db.is_absolute() else home / db,
            max_hops=int(e("MUSAB_MAX_HOPS", "6")),
            poll_seconds=float(e("MUSAB_POLL_SECONDS", "2")),
            max_tool_steps=int(e("MUSAB_MAX_TOOL_STEPS", "8")),
            teams_dir=teams if teams.is_absolute() else home / teams,
        )
