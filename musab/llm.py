"""Minimal DeepSeek client (OpenAI-compatible chat completions, stdlib only)."""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from typing import Protocol


class LLM(Protocol):
    def chat(self, *, model: str, messages: list[dict], tools: list[dict] | None,
             thinking: str) -> dict:
        """Return an assistant message dict ready to append to `messages`."""


class DeepSeek:
    def __init__(self, api_key: str, base_url: str = "https://api.deepseek.com",
                 timeout: float = 600, retries: int = 3):
        if not api_key:
            raise RuntimeError("DEEPSEEK_API_KEY is not set (put it in .env)")
        self.api_key = api_key
        self.url = base_url.rstrip("/") + "/chat/completions"
        self.timeout = timeout
        self.retries = retries

    def chat(self, *, model: str, messages: list[dict], tools: list[dict] | None,
             thinking: str = "high") -> dict:
        body: dict = {"model": model, "messages": messages}
        if tools:
            body["tools"] = tools
        if thinking in ("off", "none", "disabled", ""):
            body["thinking"] = {"type": "disabled"}
        else:
            body["thinking"] = {"type": "enabled"}
            body["reasoning_effort"] = thinking  # low | high | max

        data = self._post(body)
        msg = data["choices"][0]["message"]
        out: dict = {"role": "assistant", "content": msg.get("content") or ""}
        # DeepSeek requires reasoning_content to be sent back on later
        # requests that carry tools, so keep it on the message.
        if msg.get("reasoning_content"):
            out["reasoning_content"] = msg["reasoning_content"]
        if msg.get("tool_calls"):
            out["tool_calls"] = msg["tool_calls"]
        return out

    def _post(self, body: dict) -> dict:
        payload = json.dumps(body).encode()
        last_err: Exception | None = None
        for attempt in range(self.retries):
            req = urllib.request.Request(
                self.url, data=payload, method="POST",
                headers={"Content-Type": "application/json",
                         "Authorization": f"Bearer {self.api_key}"})
            try:
                with urllib.request.urlopen(req, timeout=self.timeout) as r:
                    return json.loads(r.read())
            except urllib.error.HTTPError as e:
                detail = e.read().decode(errors="replace")[:500]
                last_err = RuntimeError(f"DeepSeek HTTP {e.code}: {detail}")
                if e.code not in (429, 500, 502, 503, 504):
                    raise last_err
            except (urllib.error.URLError, TimeoutError) as e:
                last_err = e
            time.sleep(2 ** attempt)
        raise RuntimeError(f"DeepSeek request failed: {last_err}")
