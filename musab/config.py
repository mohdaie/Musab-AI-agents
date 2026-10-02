from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


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

    @property
    def agents_dir(self) -> Path:
        return self.home / "agents"

    @property
    def skills_dir(self) -> Path:
        return self.home / "skills"

    @classmethod
    def load(cls, home: str | Path = ".") -> "Config":
        home = Path(home).resolve()
        load_dotenv(home / ".env")
        e = os.environ.get
        db = Path(e("MUSAB_DB", "data/musab.db"))
        return cls(
            home=home,
            api_key=e("DEEPSEEK_API_KEY", ""),
            base_url=e("DEEPSEEK_BASE_URL", "https://api.deepseek.com"),
            model=e("DEEPSEEK_MODEL", "deepseek-v4-pro"),
            db_path=db if db.is_absolute() else home / db,
            max_hops=int(e("MUSAB_MAX_HOPS", "6")),
            poll_seconds=float(e("MUSAB_POLL_SECONDS", "2")),
            max_tool_steps=int(e("MUSAB_MAX_TOOL_STEPS", "8")),
        )
