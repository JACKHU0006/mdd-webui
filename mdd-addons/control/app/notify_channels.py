"""Bark and email notification channels.

The control plane ships four channels (webhook, Telegram, PushPlus, Feishu) in
`notify_push.py`. These two live apart for the same reason `at_terminal.py` does: adding a
channel should not mean editing a 800-line file, and a new module can be tested on its own.

INSTALLING THIS
---------------
Three small edits, all documented at the bottom of this file:

  1. `notify_push.dispatch()` — iterate `CHANNELS` alongside the built-in four.
  2. `notify_push.has_enabled_channel()` — include the new keys.
  3. `main.py` — validate the new sections on `PUT /api/settings`, and expose the two test
     endpoints.

WHAT THESE CHANNELS ADD
-----------------------
**Bark** is the pragmatic iOS push app in China: no bot, no chat, no account to link — a
device key and an HTTPS GET. It is also commonly *self-hosted*, so the server URL is
configurable rather than hardcoded, and that is the one place this module has to be careful:
a self-hosted server on a LAN is often plain HTTP, and the device key travels in the request.
HTTP is therefore allowed (self-hosting is a real use case, not a mistake) but the docs say
plainly what it costs.

**Email** uses `smtplib` from the standard library, so it adds no dependency. Three
transport modes, because all three are still in the wild: implicit TLS on 465, STARTTLS on
587, and plain on 25. The port follows the mode unless it is set explicitly, which is the
only default that does not surprise anyone.

Both channels reuse `build_notification_message`, so per-event title/content overrides and
`{{token}}` templates behave exactly as they do everywhere else — a channel that quietly
ignored the templates would be worse than no channel.
"""

from __future__ import annotations

import smtplib
import ssl
from email.message import EmailMessage
from typing import Any, Callable

import requests

#: Kept short so a dead endpoint cannot pile up threads. Matches `notify_push._TIMEOUT`.
_TIMEOUT = 8

# ------------------------------------------------------------------------------ shared

def _message(payload: dict, cfg: dict) -> dict:
    """The shared title/content, with any per-event override applied.

    Imported lazily: `notify_push` imports this module to build its channel list, so a
    module-level import would be circular. The same trick `mms_transport` uses for pyserial.
    """
    from . import notify_push

    return notify_push.build_notification_message(payload, cfg)


def _text(value: Any) -> str:
    return str(value or "").strip()


# -------------------------------------------------------------------------------- Bark

BARK_DEFAULT_SERVER = "https://api.day.app"

#: Bark's interruption levels. `critical` bypasses the silent switch and needs the app to
#: have been granted that permission, which is why it is not the default.
BARK_LEVELS = ("active", "timeSensitive", "passive", "critical")


def bark_server(cfg: dict) -> str:
    """The Bark server base URL, without a trailing slash."""
    raw = _text(cfg.get("server")) or BARK_DEFAULT_SERVER
    return raw.rstrip("/")


def validate_bark(cfg: dict) -> None:
    """Raise `ValueError` for a configuration that cannot work.

    Only enforced when the channel is enabled: a half-filled channel that is switched off is
    a draft, and refusing to save it would lose the operator's typing.
    """
    if not cfg.get("enabled"):
        return
    if not _text(cfg.get("device_key")):
        raise ValueError("Bark 需要填写设备 Key")
    level = _text(cfg.get("level")) or "active"
    if level not in BARK_LEVELS:
        raise ValueError(f"Bark 推送级别必须是 {'/'.join(BARK_LEVELS)} 之一")
    server = bark_server(cfg)
    if not server.startswith(("http://", "https://")):
        raise ValueError("Bark 服务器地址必须以 http:// 或 https:// 开头")


def send_bark(cfg: dict, payload: dict) -> dict:
    """Send one message through Bark's JSON push endpoint.

    The JSON endpoint is used rather than the `/key/title/body` path form because the title
    and body are arbitrary Chinese text: path segments would need percent-encoding, and the
    readable URL form has a length limit that a template can easily exceed.
    """
    key = _text(cfg.get("device_key"))
    if not key:
        raise ValueError("Bark device key is required")

    message = _message(payload, cfg)
    body: dict[str, Any] = {
        "device_key": key,
        "title": message.get("title") or "",
        "body": message.get("content") or "",
    }
    level = _text(cfg.get("level"))
    if level:
        body["level"] = level
    for source, target in (("group", "group"), ("sound", "sound"), ("icon", "icon"), ("url", "url")):
        value = _text(cfg.get(source))
        if value:
            body[target] = value
    # `isArchive` keeps the message in Bark's history; on by default is what people expect
    # from a notification they may not have been looking at when it arrived.
    body["isArchive"] = 1 if cfg.get("archive", True) else 0

    url = f"{bark_server(cfg)}/push"
    try:
        response = requests.post(url, json=body, timeout=_TIMEOUT)
        response.raise_for_status()
        result = response.json()
    except (requests.RequestException, ValueError):
        # Deliberately generic: the request carries the device key, and an exception message
        # can echo the URL. `_deliver_with_retry` records only the exception type anyway.
        raise RuntimeError("Bark 推送请求失败") from None

    # Bark answers HTTP 200 with its own code, exactly like PushPlus — a 200 alone is not
    # proof of delivery.
    if not isinstance(result, dict) or int(result.get("code") or 0) != 200:
        raise RuntimeError("Bark 拒绝了这条推送")
    return {"ok": True, "status_code": response.status_code}


# ------------------------------------------------------------------------------- Email

#: Transport modes, with the port each one conventionally uses.
EMAIL_TLS_MODES: dict[str, int] = {"ssl": 465, "starttls": 587, "none": 25}


def email_port(cfg: dict) -> int:
    raw = cfg.get("port")
    if raw in (None, ""):
        return EMAIL_TLS_MODES.get(_text(cfg.get("tls_mode")) or "starttls", 587)
    try:
        port = int(raw)
    except (TypeError, ValueError):
        raise ValueError("SMTP 端口必须是数字") from None
    if not 1 <= port <= 65535:
        raise ValueError("SMTP 端口必须在 1-65535 之间")
    return port


def email_recipients(cfg: dict) -> list[str]:
    """Recipients as a list. Accepts a list or a comma/semicolon separated string."""
    raw = cfg.get("to")
    if isinstance(raw, (list, tuple)):
        items = [str(item) for item in raw]
    else:
        items = str(raw or "").replace(";", ",").split(",")
    return [item.strip() for item in items if item.strip()]


def validate_email(cfg: dict) -> None:
    if not cfg.get("enabled"):
        return
    if not _text(cfg.get("host")):
        raise ValueError("邮件需要填写 SMTP 服务器")
    mode = _text(cfg.get("tls_mode")) or "starttls"
    if mode not in EMAIL_TLS_MODES:
        raise ValueError(f"邮件加密方式必须是 {'/'.join(EMAIL_TLS_MODES)} 之一")
    email_port(cfg)  # validates the port
    sender = _text(cfg.get("from_address")) or _text(cfg.get("username"))
    if not sender:
        raise ValueError("邮件需要填写发件人地址")
    if not email_recipients(cfg):
        raise ValueError("邮件至少需要一个收件人")


def send_email(cfg: dict, payload: dict) -> dict:
    """Send one message over SMTP.

    `EmailMessage` is used rather than a hand-built MIME body so that Chinese in the subject
    and the body is encoded correctly — a manually assembled `Subject:` header with non-ASCII
    in it is the classic way to produce mojibake that only shows up on some clients.
    """
    host = _text(cfg.get("host"))
    if not host:
        raise ValueError("SMTP host is required")
    mode = _text(cfg.get("tls_mode")) or "starttls"
    if mode not in EMAIL_TLS_MODES:
        raise ValueError("unsupported SMTP transport mode")
    port = email_port(cfg)

    recipients = email_recipients(cfg)
    if not recipients:
        raise ValueError("at least one recipient is required")
    sender = _text(cfg.get("from_address")) or _text(cfg.get("username"))
    if not sender:
        raise ValueError("a sender address is required")

    message = _message(payload, cfg)
    subject_prefix = _text(cfg.get("subject_prefix"))
    subject = message.get("title") or "MDD"
    if subject_prefix:
        subject = f"{subject_prefix} {subject}"

    mail = EmailMessage()
    mail["Subject"] = subject
    mail["From"] = sender
    mail["To"] = ", ".join(recipients)
    mail.set_content(message.get("content") or "")

    username = _text(cfg.get("username"))
    password = str(cfg.get("password") or "")

    try:
        if mode == "ssl":
            client: smtplib.SMTP = smtplib.SMTP_SSL(
                host, port, timeout=_TIMEOUT, context=ssl.create_default_context()
            )
        else:
            client = smtplib.SMTP(host, port, timeout=_TIMEOUT)
        try:
            if mode == "starttls":
                client.starttls(context=ssl.create_default_context())
            if username:
                client.login(username, password)
            client.send_message(mail)
        finally:
            try:
                client.quit()
            except Exception:  # noqa: BLE001 -- closing a dead socket is not a failure
                pass
    except (OSError, smtplib.SMTPException):
        # Generic on purpose: SMTP errors can quote the credentials in the server's own
        # rejection text. `_deliver_with_retry` records only the exception type.
        raise RuntimeError("邮件发送失败") from None

    return {"ok": True, "status_code": 250}


# ---------------------------------------------------------------------------- registry

#: `settings_key -> sender`. `dispatch()` iterates this, so adding a channel here is enough
#: to make it deliverable; nothing in `notify_push` has to know what Bark or email are.
CHANNELS: dict[str, Callable[[dict, dict], dict]] = {
    "bark": send_bark,
    "email": send_email,
}

#: `settings_key -> validator`, called from the settings route when a section is submitted.
VALIDATORS: dict[str, Callable[[dict], None]] = {
    "bark": validate_bark,
    "email": validate_email,
}

#: The settings keys this module owns. Used by the patch to `has_enabled_channel`.
SETTINGS_KEYS: tuple[str, ...] = tuple(CHANNELS)


# ------------------------------------------------------------------- install (patches)

INSTALL_NOTES = """
Four edits. The first is a module-level import in `notify_push.py` — put it with the other
imports at the top of the file, so both functions below can see it:

  0. `control/app/notify_push.py`, with the other imports:

         from . import notify_channels

     There is no import cycle: this module only reaches back into `notify_push` lazily, from
     inside `_message()`, the same way `mms_transport` defers pyserial.

  1. `control/app/notify_push.py` — in `dispatch()`, after the Feishu loop and before the
     delivery loop:

         for key, sender in notify_channels.CHANNELS.items():
             extra = settings.get(key) or {}
             if extra.get("enabled") and _events_enabled(extra).get(event):
                 deliveries.append((key, sender, extra))

  2. `control/app/notify_push.py` — in `has_enabled_channel()`, add the new keys to the
     standard-channel comprehension:

         for key in ("webhook", "telegram", "pushplus", *notify_channels.SETTINGS_KEYS))

  3. `control/app/main.py` — validate on save (next to the existing Feishu validation), and
     expose the two test endpoints alongside the other four. The senders live in
     `notify_channels`, NOT in `notify_push`:

         from . import notify_channels
         ...
         for key, validate in notify_channels.VALIDATORS.items():
             if key in patch:
                 try:
                     validate(patch[key] or {})
                 except ValueError as exc:
                     raise HTTPException(400, str(exc)) from None

         @app.post("/api/notifications/bark/test")
         async def api_bark_test(body: dict):
             return await asyncio.to_thread(
                 notify_channels.send_bark, body,
                 _test_push_payload(_notification_test_event(body)))

         @app.post("/api/notifications/email/test")
         async def api_email_test(body: dict):
             return await asyncio.to_thread(
                 notify_channels.send_email, body,
                 _test_push_payload(_notification_test_event(body)))
"""
