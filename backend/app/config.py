"""App settings. Override any field with an environment variable prefixed GNOSIA_
(e.g. GNOSIA_DATABASE_URL=postgresql+psycopg://...)."""
import shutil
from pathlib import Path

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parent.parent
ROOT_DIR = BACKEND_DIR.parent


def _find_node() -> str:
    found = shutil.which("node")
    if found:
        return found
    for guess in (r"C:\Program Files\nodejs\node.exe", "/usr/local/bin/node", "/usr/bin/node"):
        if Path(guess).exists():
            return guess
    return "node"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="GNOSIA_", env_file=BACKEND_DIR / ".env", extra="ignore")

    # PostgreSQL in development and production, e.g. postgresql+psycopg://gnosia:***@localhost:5432/gnosia (set in backend/.env).
    # Falls back to a local SQLite file when nothing is configured.
    database_url: str = f"sqlite:///{(BACKEND_DIR / 'gnosia.db').as_posix()}"
    secret_key: str = "dev-only-change-me-in-production"
    session_cookie: str = "gnosia_session"
    session_days: int = 30
    cookie_secure: bool = False

    # Day boundaries for streaks and daily goals (WIB, no DST).
    utc_offset_hours: int = 7

    node_bin: str = _find_node()
    runner_timeout_ms: int = 1000

    frontend_dist: Path = ROOT_DIR / "frontend" / "dist"

    @field_validator("database_url")
    @classmethod
    def _psycopg_url(cls, v: str) -> str:
        # Hosted Postgres (Neon, Supabase, Render) hands out postgres:// or postgresql:// URLs; SQLAlchemy needs the psycopg driver.
        for prefix in ("postgres://", "postgresql://"):
            if v.startswith(prefix):
                return "postgresql+psycopg://" + v[len(prefix):]
        return v


settings = Settings()
