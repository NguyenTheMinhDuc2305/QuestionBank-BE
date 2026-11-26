from functools import lru_cache
from typing import Literal

from pydantic import Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    supabase_url: str
    supabase_secret_key: SecretStr
    supabase_images_bucket: str = "question-images"
    supabase_audios_bucket: str = "question-audios"
    admin_emails: list[str] = Field(default_factory=list)
    cors_origins: list[str] = Field(default_factory=lambda: ["http://localhost:3000"])
    openrouter_api_key: SecretStr = SecretStr("")
    openrouter_text_model: str = ""
    openrouter_audio_model: str = ""
    openrouter_audio_voice: str = ""
    openrouter_audio_api: Literal["chat", "speech"] = "chat"
    openrouter_speech_instructions: bool = False
    img_gen_api_key: SecretStr = SecretStr("")
    img_gen_base_url: str = "https://genimg.tguru.vn:8000"
    image_poll_seconds: float = Field(default=3, gt=0)
    image_timeout_seconds: int = Field(default=600, ge=10)
    max_media_bytes: int = Field(default=20 * 1024 * 1024, ge=1024)
    max_active_jobs_per_user: int = Field(default=3, ge=1, le=20)
    worker_poll_seconds: float = Field(default=3, gt=0)
    worker_lease_seconds: int = Field(default=180, ge=60)

    @field_validator("supabase_url")
    @classmethod
    def project_url(cls, value: str) -> str:
        from urllib.parse import urlparse

        url = urlparse(value)
        if url.scheme != "https" or not (url.hostname or "").endswith(".supabase.co"):
            raise ValueError("Use the HTTPS project API URL, not the Supabase dashboard URL")
        if url.path not in ("", "/") or url.query or url.fragment or url.username:
            raise ValueError("SUPABASE_URL must be a project root URL")
        return value.rstrip("/")

    def generation_errors(self, *, images: bool, audio: bool) -> list[str]:
        missing = []
        for name in ["openrouter_api_key", "openrouter_text_model"]:
            v = getattr(self, name)
            if not (v.get_secret_value() if isinstance(v, SecretStr) else v):
                missing.append(name.upper())
        if images and not self.img_gen_api_key.get_secret_value():
            missing.append("IMG_GEN_API_KEY")
        if audio:
            for name in ["openrouter_audio_model", "openrouter_audio_voice"]:
                if not getattr(self, name):
                    missing.append(name.upper())
        return missing


@lru_cache
def get_settings() -> Settings:
    return Settings()
