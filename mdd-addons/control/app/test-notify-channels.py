#!/usr/bin/env python3
"""Behavioural checks for notify_channels.py (Bark and email).

Neither channel can be exercised against a real service here, but everything that decides
whether a message goes out — and what goes in it — can be. What is worth proving:

  1. **HTTP 200 is not delivery.** Bark, like PushPlus, answers 200 with its own application
     code. Treating the transport status as the verdict would report a rejected push as sent.

  2. **The credential never reaches the error message.** The Bark device key rides in the
     request body and the SMTP password in the login call; an exception that echoes either
     would put it in the delivery log, which is meant to hold metadata only.

  3. **The port follows the transport mode.** 465 for implicit TLS, 587 for STARTTLS, 25 for
     plain — unless set explicitly. Getting this wrong produces a connection that hangs rather
     than an error that explains itself.

  4. **Chinese survives the subject line.** A hand-built `Subject:` header with non-ASCII in
     it is the classic source of mojibake that only shows up on some clients.

  5. **A disabled channel is a draft, not an error.** Validation runs on enabled channels
     only, so half-typed configuration can be saved.

Usage: python3 test-notify-channels.py
"""

from __future__ import annotations

import importlib.util
import os
import sys
import types
from email.message import EmailMessage

HERE = os.path.dirname(os.path.abspath(__file__))

results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, ok, detail))
    print(f"{'PASS' if ok else 'FAIL'}  {name}{' — ' + detail if detail else ''}")


# --------------------------------------------------------------------------- fakes

class FakeResponse:
    def __init__(self, payload, status_code=200, raise_exc=None):
        self._payload = payload
        self.status_code = status_code
        self._raise_exc = raise_exc

    def raise_for_status(self):
        if self._raise_exc:
            raise self._raise_exc

    def json(self):
        if isinstance(self._payload, Exception):
            raise self._payload
        return self._payload


class FakeRequests:
    def __init__(self):
        self.calls = []
        self.response = FakeResponse({"code": 200, "message": "success"})
        self.error = None

    def post(self, url, **kwargs):
        self.calls.append((url, kwargs))
        if self.error:
            raise self.error
        return self.response


def install_requests_stub(fake: FakeRequests) -> None:
    """Put a minimal `requests` in `sys.modules`.

    `notify_channels` imports it at module scope because in production it is a hard dependency
    of the control plane (`notify_push` uses it too). The test should not need a third-party
    package installed to check the logic, so the two attributes the module touches are
    provided here.
    """
    stub = types.ModuleType("requests")

    class RequestException(Exception):
        pass

    stub.RequestException = RequestException
    stub.post = fake.post
    sys.modules["requests"] = stub


class FakeSMTP:
    """Records the conversation so the transport mode and login can be asserted."""

    instances: list["FakeSMTP"] = []

    def __init__(self, host, port, timeout=None, context=None):
        self.host = host
        self.port = port
        self.timeout = timeout
        self.context = context
        self.started_tls = False
        self.login_args = None
        self.sent = None
        self.quit_called = False
        self.fail_on = None
        FakeSMTP.instances.append(self)

    def starttls(self, context=None):
        if self.fail_on == "starttls":
            raise OSError("starttls refused")
        self.started_tls = True
        self.context = context

    def login(self, username, password):
        if self.fail_on == "login":
            raise OSError("auth refused for user with password hunter2")
        self.login_args = (username, password)

    def send_message(self, message):
        if self.fail_on == "send":
            raise OSError("send refused")
        self.sent = message

    def quit(self):
        self.quit_called = True


class FakeSMTPSSL(FakeSMTP):
    pass


class FakeNotifyPush:
    """Stands in for `notify_push.build_notification_message`."""

    @staticmethod
    def build_notification_message(payload, cfg=None):
        return {"title": "MDD · 收到短信 · Home SIM", "content": "SIM: Home SIM\n\n你好，世界"}


def load_module():
    """Load notify_channels.py as `atpkg.notify_channels` inside a synthetic package.

    The module defers `from . import notify_push` to call time so that importing it needs
    nothing installed; loading it standalone would make that relative import fail.
    """
    package = types.ModuleType("atpkg")
    package.__path__ = []
    sys.modules["atpkg"] = package

    sys.modules["atpkg.notify_push"] = FakeNotifyPush

    spec = importlib.util.spec_from_file_location(
        "atpkg.notify_channels", os.path.join(HERE, "notify_channels.py")
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules["atpkg.notify_channels"] = module
    spec.loader.exec_module(module)
    return module


def main() -> int:
    fake_requests = FakeRequests()
    install_requests_stub(fake_requests)
    m = load_module()
    m.requests = sys.modules["requests"]
    m.smtplib.SMTP = FakeSMTP
    m.smtplib.SMTP_SSL = FakeSMTPSSL
    FakeSMTP.instances = []

    payload = {"event": "incoming_sms", "instance": "line-1", "text": "你好，世界"}

    # ---- Bark: server handling ---------------------------------------------------
    check(
        "the default Bark server is api.day.app",
        m.bark_server({}) == "https://api.day.app",
        m.bark_server({}),
    )
    check(
        "a self-hosted server is honoured",
        m.bark_server({"server": "https://bark.example.com"}) == "https://bark.example.com",
    )
    check(
        "a trailing slash is stripped",
        m.bark_server({"server": "https://bark.example.com/"}) == "https://bark.example.com",
        m.bark_server({"server": "https://bark.example.com/"}),
    )
    check(
        "a plain-HTTP self-hosted server is accepted",
        m.bark_server({"server": "http://192.168.1.10:8080"}) == "http://192.168.1.10:8080",
        "self-hosting on a LAN is the normal case, not a mistake",
    )

    # ---- Bark: validation --------------------------------------------------------
    check(
        "an enabled channel without a device key is rejected",
        _raises(m.validate_bark, {"enabled": True}),
    )
    check(
        "a disabled channel is not validated",
        not _raises(m.validate_bark, {"enabled": False}),
        "a half-filled channel that is switched off is a draft",
    )
    check(
        "an unknown push level is rejected",
        _raises(m.validate_bark, {"enabled": True, "device_key": "k", "level": "loud"}),
    )
    check(
        "a known push level is accepted",
        not _raises(m.validate_bark, {"enabled": True, "device_key": "k", "level": "timeSensitive"}),
    )
    check(
        "a server without a scheme is rejected",
        _raises(m.validate_bark, {"enabled": True, "device_key": "k", "server": "bark.example.com"}),
        "a bare hostname would be posted to as a relative URL",
    )

    # ---- Bark: the request -------------------------------------------------------
    fake_requests.calls = []
    result = m.send_bark({"device_key": "KEY123"}, payload)
    check("a Bark push succeeds on code 200", result["ok"] is True, str(result))
    url, kwargs = fake_requests.calls[0]
    check("it posts to the /push endpoint", url == "https://api.day.app/push", url)
    body = kwargs["json"]
    check("the device key is sent", body.get("device_key") == "KEY123")
    check("the title is sent", body.get("title") == "MDD · 收到短信 · Home SIM", str(body.get("title")))
    check("the body is sent", "你好，世界" in str(body.get("body")), str(body.get("body")))
    check("archiving defaults to on", body.get("isArchive") == 1, str(body.get("isArchive")))
    check(
        "optional fields are omitted when unset",
        "level" not in body and "group" not in body and "sound" not in body,
        str(sorted(body)),
    )

    fake_requests.calls = []
    m.send_bark(
        {"device_key": "K", "level": "critical", "group": "mdd", "sound": "alarm", "archive": False},
        payload,
    )
    body = fake_requests.calls[0][1]["json"]
    check(
        "optional fields are included when set",
        body.get("level") == "critical" and body.get("group") == "mdd" and body.get("sound") == "alarm",
        str(body),
    )
    check("archiving can be turned off", body.get("isArchive") == 0)

    # ---- Bark: 200 is not delivery ----------------------------------------------
    fake_requests.response = FakeResponse({"code": 400, "message": "bad key"})
    check(
        "an application-level Bark error is a failure",
        _raises(m.send_bark, {"device_key": "K"}, payload, expect=RuntimeError),
        "Bark answers HTTP 200 with its own code, so the status alone proves nothing",
    )

    fake_requests.response = FakeResponse(ValueError("not json"))
    check(
        "a non-JSON Bark reply is a failure",
        _raises(m.send_bark, {"device_key": "K"}, payload, expect=RuntimeError),
    )

    fake_requests.response = FakeResponse({"code": 200})
    fake_requests.error = sys.modules["requests"].RequestException(
        "connection refused to https://api.day.app/push?key=SECRET"
    )
    try:
        m.send_bark({"device_key": "SECRET"}, payload)
        check("a transport error is raised", False, "no exception")
    except RuntimeError as exc:
        check("a transport error is raised", True)
        check(
            "the error message does not echo the request",
            "SECRET" not in str(exc) and "http" not in str(exc),
            f"message={str(exc)!r} — the body carries the device key",
        )
    fake_requests.error = None
    fake_requests.response = FakeResponse({"code": 200})

    # ---- Email: port follows the transport mode ---------------------------------
    check("SSL defaults to 465", m.email_port({"tls_mode": "ssl"}) == 465)
    check("STARTTLS defaults to 587", m.email_port({"tls_mode": "starttls"}) == 587)
    check("plain defaults to 25", m.email_port({"tls_mode": "none"}) == 25)
    check("an unset mode defaults to STARTTLS", m.email_port({}) == 587)
    check("an explicit port wins", m.email_port({"tls_mode": "ssl", "port": 2525}) == 2525)
    check("a non-numeric port is rejected", _raises(m.email_port, {"port": "abc"}))
    check("an out-of-range port is rejected", _raises(m.email_port, {"port": 70000}))

    # ---- Email: recipients -------------------------------------------------------
    check("a list of recipients is accepted", m.email_recipients({"to": ["a@x.com", "b@x.com"]}) == ["a@x.com", "b@x.com"])
    check("a comma-separated string is accepted", m.email_recipients({"to": "a@x.com,b@x.com"}) == ["a@x.com", "b@x.com"])
    check("a semicolon-separated string is accepted", m.email_recipients({"to": "a@x.com; b@x.com"}) == ["a@x.com", "b@x.com"])
    check("surrounding whitespace is trimmed", m.email_recipients({"to": " a@x.com , b@x.com "}) == ["a@x.com", "b@x.com"])
    check("empty entries are dropped", m.email_recipients({"to": "a@x.com,,  ,b@x.com"}) == ["a@x.com", "b@x.com"])

    # ---- Email: validation -------------------------------------------------------
    check("an enabled channel without a host is rejected", _raises(m.validate_email, {"enabled": True}))
    check(
        "an enabled channel without a recipient is rejected",
        _raises(m.validate_email, {"enabled": True, "host": "smtp.x.com", "from_address": "a@x.com"}),
    )
    check(
        "an unknown transport mode is rejected",
        _raises(m.validate_email, {"enabled": True, "host": "s", "tls_mode": "plain", "from_address": "a@x.com", "to": "b@x.com"}),
    )
    check(
        "a complete configuration passes",
        not _raises(m.validate_email, {"enabled": True, "host": "smtp.x.com", "from_address": "a@x.com", "to": "b@x.com"}),
        "tls_mode and port are both defaultable",
    )
    check("a disabled channel is not validated", not _raises(m.validate_email, {"enabled": False}))

    # ---- Email: the message ------------------------------------------------------
    FakeSMTP.instances = []
    result = m.send_email(
        {"host": "smtp.x.com", "from_address": "bot@x.com", "to": "me@x.com"},
        payload,
    )
    check("an email send succeeds", result["ok"] is True, str(result))
    client = FakeSMTP.instances[-1]
    check("it connects to the configured host", client.host == "smtp.x.com")
    check("STARTTLS is negotiated by default", client.started_tls)
    check("it does not log in without a username", client.login_args is None)

    mail = client.sent
    check("a message is sent", isinstance(mail, EmailMessage))
    check("the recipient is set", mail["To"] == "me@x.com", str(mail["To"]))
    check("the sender is set", mail["From"] == "bot@x.com", str(mail["From"]))
    check(
        "the Chinese subject survives a round trip",
        "收到短信" in str(mail["Subject"]),
        str(mail["Subject"]),
    )
    raw = mail.as_bytes()
    header_block, _, _ = raw.partition(b"\n\n")
    check(
        "the subject header is encoded, not raw UTF-8",
        all(byte < 128 for byte in header_block),
        "a raw non-ASCII header is the classic mojibake source",
    )
    check(
        "the Chinese body survives",
        "你好，世界".encode("utf-8") in raw,
        "the body must be UTF-8 encoded",
    )
    check("the connection is closed", client.quit_called)

    # ---- Email: subject prefix ---------------------------------------------------
    FakeSMTP.instances = []
    m.send_email(
        {"host": "smtp.x.com", "from_address": "a@x.com", "to": "b@x.com", "subject_prefix": "[网关]"},
        payload,
    )
    check(
        "a subject prefix is applied",
        str(FakeSMTP.instances[-1].sent["Subject"]).startswith("[网关]"),
        str(FakeSMTP.instances[-1].sent["Subject"]),
    )

    # ---- Email: transport modes --------------------------------------------------
    FakeSMTP.instances = []
    m.send_email({"host": "h", "tls_mode": "ssl", "from_address": "a@x.com", "to": "b@x.com"}, payload)
    check(
        "ssl mode uses an implicit-TLS connection",
        isinstance(FakeSMTP.instances[-1], FakeSMTPSSL),
        type(FakeSMTP.instances[-1]).__name__,
    )
    check("ssl mode does not STARTTLS again", not FakeSMTP.instances[-1].started_tls)

    FakeSMTP.instances = []
    m.send_email({"host": "h", "tls_mode": "none", "from_address": "a@x.com", "to": "b@x.com"}, payload)
    check(
        "plain mode uses a plain connection",
        not isinstance(FakeSMTP.instances[-1], FakeSMTPSSL) and not FakeSMTP.instances[-1].started_tls,
    )

    FakeSMTP.instances = []
    m.send_email(
        {"host": "h", "username": "u", "password": "p", "from_address": "a@x.com", "to": "b@x.com"},
        payload,
    )
    check(
        "it logs in when a username is set",
        FakeSMTP.instances[-1].login_args == ("u", "p"),
        str(FakeSMTP.instances[-1].login_args),
    )

    # ---- Email: failures are generic --------------------------------------------
    FakeSMTP.instances = []
    failing = FakeSMTP("h", 587)
    failing.fail_on = "login"
    m.smtplib.SMTP = lambda *a, **k: failing
    try:
        m.send_email({"host": "h", "username": "u", "password": "hunter2", "from_address": "a@x.com", "to": "b@x.com"}, payload)
        check("an SMTP failure is raised", False, "no exception")
    except RuntimeError as exc:
        check("an SMTP failure is raised", True)
        check(
            "the error message does not echo the server's credentials text",
            "hunter2" not in str(exc),
            f"message={str(exc)!r} — SMTP errors can quote the credentials",
        )
    m.smtplib.SMTP = FakeSMTP

    # ---- the registry ------------------------------------------------------------
    check(
        "both channels are registered for dispatch",
        set(m.CHANNELS) == {"bark", "email"},
        str(sorted(m.CHANNELS)),
    )
    check(
        "both channels have a validator",
        set(m.VALIDATORS) == {"bark", "email"},
        str(sorted(m.VALIDATORS)),
    )

    failed = [name for name, ok, _ in results if not ok]
    print()
    print(f"{len(results) - len(failed)}/{len(results)} passed")
    return 1 if failed else 0


def _raises(fn, *args, expect=ValueError) -> bool:
    """True when `fn` raises the expected kind of error.

    Two kinds are expected here and they mean different things: `ValueError` is a
    configuration the operator has to fix, `RuntimeError` is a delivery that failed. A test
    that accepted either would not notice the two being confused.
    """
    try:
        fn(*args)
        return False
    except expect:
        return True


if __name__ == "__main__":
    sys.exit(main())
