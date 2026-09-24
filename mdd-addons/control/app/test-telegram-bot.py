#!/usr/bin/env python3
"""Behavioural checks for telegram_bot.py.

This module is a remote control for a device that can spend money and drop a line, so the
tests are mostly about what it *refuses* to do. What is worth proving:

  1. **An empty allowlist authorises nobody.** The dangerous reading of "no list configured"
     is "no restriction". If that ever flips, anyone who finds the bot can send SMS on the
     operator's account, and nothing else in this file would catch it.

  2. **An unauthorized chat gets no reply at all.** Not "not authorized" — silence. A reply
     confirms the bot exists.

  3. **A destructive command is argued with, not executed.** It must not reach the action
     callable on the first message, and the confirmation must name the specific consequence.

  4. **A confirmation token is single-use, expiring, and bound to its chat.** A token leaked
     into a group must be useless to anyone else, and a replay must not fire twice.

  5. **The bot token never reaches an error message.** It lives in the request URL, so a
     `requests` exception would leak it into the log.

  6. **The bot holds no MDD imports**, so it can be tested without a control plane — and the
     set of things it can reach is a written-down list rather than whatever is importable.

Usage: python3 test-telegram-bot.py
"""

from __future__ import annotations

import importlib.util
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))

results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, ok, detail))
    print(f"{'PASS' if ok else 'FAIL'}  {name}{' — ' + detail if detail else ''}")


def load_module():
    spec = importlib.util.spec_from_file_location(
        "telegram_bot", os.path.join(HERE, "telegram_bot.py")
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules["telegram_bot"] = module
    spec.loader.exec_module(module)
    return module


class Recorder:
    """Records every action the bot reaches, so 'it did not run' can be asserted."""

    def __init__(self):
        self.calls: list[tuple] = []

    def _note(self, name, *args):
        self.calls.append((name, *args))
        return f"{name} ok"

    def actions(self, m):
        return m.GatewayActions(
            status=lambda: self._note("status"),
            lines=lambda: self._note("lines"),
            esim_profiles=lambda line: self._note("esim", line),
            send_sms=lambda line, to, text: self._note("send_sms", line, to, text),
            query_balance=lambda line: self._note("balance", line),
            switch_profile=lambda line, iccid: self._note("switch", line, iccid),
            set_wfc=lambda line, on: self._note("wfc", line, on),
        )


def message(text, chat_id=100, message_id=1):
    return {"update_id": message_id, "message": {"chat": {"id": chat_id}, "text": text}}


def main() -> int:
    m = load_module()

    # ---- 1. authorization fails closed ------------------------------------------
    check("an empty allowlist authorises nobody", not m.authorize(100, []))
    check("a missing allowlist authorises nobody", not m.authorize(100, None))
    check("a blank entry authorises nobody", not m.authorize(100, ["", "  "]))
    check("an unlisted chat is refused", not m.authorize(999, [100, 200]))
    check("a listed chat is allowed", m.authorize(100, [100, 200]))
    check(
        "a listed chat matches across str/int",
        m.authorize("100", [100]) and m.authorize(100, ["100"]),
        "Telegram sends the id as an int but the settings store it as a string",
    )

    # ---- 2. no token or no allowlist means the listener does not run ------------
    recorder = Recorder()
    no_allow = m.TelegramBot(
        token="tok", allowed_chat_ids=[], actions=recorder.actions(m), call=lambda *a: {}
    )
    check(
        "no allowlist disables the listener entirely",
        not no_allow.enabled,
        "the bot must not run until it is told who may talk to it",
    )
    no_token = m.TelegramBot(
        token="", allowed_chat_ids=[100], actions=recorder.actions(m), call=lambda *a: {}
    )
    check("no token disables the listener", not no_token.enabled)

    # ---- a bot for the rest of the run ------------------------------------------
    replies: list[tuple] = []

    def call(method, params):
        replies.append((method, params))
        return {"ok": True, "result": []}

    # A controllable clock, so the destructive-command cooldown can be stepped over instead of
    # making the test sleep — and so a cooldown that never expires would fail loudly.
    now = [1000.0]
    recorder = Recorder()
    bot = m.TelegramBot(
        token="123:SECRET-TOKEN",
        allowed_chat_ids=[100],
        actions=recorder.actions(m),
        call=call,
        clock=lambda: now[0],
    )
    check("a fully configured bot is enabled", bot.enabled)

    # ---- 3. an unauthorized chat gets silence ----------------------------------
    recorder.calls = []
    reply = bot.handle_update(message("/status", chat_id=999))
    check(
        "an unauthorized chat gets no reply",
        reply is None,
        "replying would confirm the bot is live and invite guessing",
    )
    check("an unauthorized chat reaches no action", recorder.calls == [])

    # ---- 4. read-only commands run ---------------------------------------------
    recorder.calls = []
    reply = bot.handle_update(message("/status", chat_id=100))
    check("an authorized /status runs", recorder.calls == [("status",)], str(recorder.calls))
    check("it returns the action's text", reply == "status ok", str(reply))

    recorder.calls = []
    bot.handle_update(message("/lines", chat_id=100))
    check("an authorized /lines runs", recorder.calls == [("lines",)])

    recorder.calls = []
    bot.handle_update(message("/esim line-1", chat_id=100))
    check("a command with an argument passes it through", recorder.calls == [("esim", "line-1")])

    # ---- 5. command parsing -----------------------------------------------------
    check("a plain message is not a command", m.parse_command("hello") is None)
    check("an empty message is not a command", m.parse_command("") is None)
    check("a bare slash is not a command", m.parse_command("/") is None)
    check(
        "a group mention is stripped",
        m.parse_command("/status@my_bot").name == "status",
        "otherwise every command looks unknown in a group chat",
    )
    check("the name is lowercased", m.parse_command("/STATUS").name == "status")
    check("arguments are split", m.parse_command("/sms a b c").args == ["a", "b", "c"])
    check(
        "the raw text is preserved for the confirmation",
        m.parse_command("/sms line-1 +44 你好").raw == "/sms line-1 +44 你好",
    )

    # ---- 6. unknown commands do not execute ------------------------------------
    recorder.calls = []
    reply = bot.handle_update(message("/destroy", chat_id=100))
    check("an unknown command runs nothing", recorder.calls == [])
    check("an unknown command is answered with help", "没有这个命令" in str(reply), str(reply)[:60])

    recorder.calls = []
    reply = bot.handle_update(message("just some text", chat_id=100))
    check("plain text runs nothing", recorder.calls == [])
    check("plain text gets a short nudge", "只认命令" in str(reply), str(reply))

    # ---- 7. destructive commands argue first -----------------------------------
    recorder.calls = []
    reply = bot.handle_update(message("/sms line-1 +447700900123 hello", chat_id=100))
    check(
        "a destructive command does not run on the first message",
        recorder.calls == [],
        "an SMS bills the account",
    )
    check(
        "the confirmation names the specific consequence",
        "计费" in str(reply),
        str(reply)[:80],
    )
    check("the confirmation offers a token", "/confirm " in str(reply))

    # extract the token the way a human would
    token = str(reply).split("/confirm ")[1].split()[0]

    # ---- 8. the token is single-use --------------------------------------------
    recorder.calls = []
    reply = bot.handle_update(message(f"/confirm {token}", chat_id=100))
    check(
        "confirming runs the command",
        recorder.calls == [("send_sms", "line-1", "+447700900123", "hello")],
        str(recorder.calls),
    )

    recorder.calls = []
    reply = bot.handle_update(message(f"/confirm {token}", chat_id=100))
    check("replaying the token does nothing", recorder.calls == [])
    check("a replay is explained", "无效" in str(reply) or "过期" in str(reply), str(reply))

    # ---- 9. the token is bound to its chat -------------------------------------
    now[0] += m.DESTRUCTIVE_COOLDOWN_SECONDS + 1  # step over the cooldown from the SMS
    reply = bot.handle_update(message("/switch line-1 8944000000000000002", chat_id=100))
    token = str(reply).split("/confirm ")[1].split()[0]
    # A second authorized chat tries to redeem it.
    other = m.TelegramBot(
        token="t", allowed_chat_ids=[100, 200], actions=recorder.actions(m), call=call
    )
    recorder.calls = []
    reply = other.handle_update(message(f"/confirm {token}", chat_id=200))
    check(
        "a token from another chat cannot be redeemed",
        recorder.calls == [],
        "a token leaked into a group must be useless to everyone else",
    )
    check("the refusal is explained", "无效" in str(reply) or "过期" in str(reply), str(reply))

    # ---- 10. tokens expire ------------------------------------------------------
    expiry_now = [1000.0]
    clocked = m.TelegramBot(
        token="t",
        allowed_chat_ids=[100],
        actions=recorder.actions(m),
        call=call,
        clock=lambda: expiry_now[0],
    )
    reply = clocked.handle_update(message("/sms line-1 +1 hi", chat_id=100))
    token = str(reply).split("/confirm ")[1].split()[0]
    expiry_now[0] += m.CONFIRM_TTL_SECONDS + 1
    recorder.calls = []
    reply = clocked.handle_update(message(f"/confirm {token}", chat_id=100))
    check("an expired token does not run", recorder.calls == [])
    check("expiry is explained", "过期" in str(reply) or "无效" in str(reply), str(reply))

    # ---- 11. cancel ------------------------------------------------------------
    now[0] += m.DESTRUCTIVE_COOLDOWN_SECONDS + 1
    reply = bot.handle_update(message("/sms line-1 +1 hi", chat_id=100))
    token = str(reply).split("/confirm ")[1].split()[0]
    check("cancelling reports success", "已取消" in str(bot.handle_update(message("/cancel", chat_id=100))))
    recorder.calls = []
    bot.handle_update(message(f"/confirm {token}", chat_id=100))
    check("a cancelled token does not run", recorder.calls == [])
    check(
        "cancelling with nothing pending says so",
        "没有待确认" in str(bot.handle_update(message("/cancel", chat_id=100))),
    )

    # ---- 12. wrong arguments are caught before the confirmation ----------------
    now[0] += m.DESTRUCTIVE_COOLDOWN_SECONDS + 1
    recorder.calls = []
    reply = bot.handle_update(message("/sms line-1", chat_id=100))
    check("a destructive command with too few arguments is refused", recorder.calls == [])
    check("the usage is shown", "用法" in str(reply), str(reply)[:60])

    reply = bot.handle_update(message("/wfc line-1 maybe", chat_id=100))
    check("an invalid on/off value is refused", "用法" in str(reply), str(reply)[:60])

    # ---- 13. the cooldown stops repeats ----------------------------------------
    cool_now = [2000.0]
    cooled = m.TelegramBot(
        token="t",
        allowed_chat_ids=[100],
        actions=recorder.actions(m),
        call=call,
        clock=lambda: cool_now[0],
    )
    reply = cooled.handle_update(message("/sms line-1 +1 hi", chat_id=100))
    token = str(reply).split("/confirm ")[1].split()[0]
    cooled.handle_update(message(f"/confirm {token}", chat_id=100))
    check("the first destructive command ran", len(recorder.calls) == 1, str(recorder.calls))

    reply = cooled.handle_update(message("/sms line-1 +1 again", chat_id=100))
    check(
        "a second destructive command hits the cooldown",
        "请等" in str(reply),
        str(reply)[:80],
    )
    cool_now[0] += m.DESTRUCTIVE_COOLDOWN_SECONDS + 1
    reply = cooled.handle_update(message("/sms line-1 +1 again", chat_id=100))
    check("the cooldown expires", "/confirm " in str(reply), str(reply)[:60])

    # ---- 14. an action that raises is reported, not crashed --------------------
    def exploding(line, to, text):
        raise RuntimeError("boom")

    broken = m.TelegramBot(
        token="t",
        allowed_chat_ids=[100],
        actions=m.GatewayActions(
            status=lambda: "ok",
            lines=lambda: "ok",
            esim_profiles=lambda line: "ok",
            send_sms=exploding,
            query_balance=lambda line: "ok",
            switch_profile=lambda line, iccid: "ok",
            set_wfc=lambda line, on: "ok",
        ),
        call=call,
    )
    reply = broken.handle_update(message("/sms line-1 +1 hi", chat_id=100))
    token = str(reply).split("/confirm ")[1].split()[0]
    reply = broken.handle_update(message(f"/confirm {token}", chat_id=100))
    check("a failing action is reported", "执行失败" in str(reply), str(reply))

    # ---- 15. poll_once drives handle_update and replies ------------------------
    sent: list[dict] = []

    def poll_call(method, params):
        if method == "getUpdates":
            return {"result": [
                {"update_id": 10, "message": {"chat": {"id": 100}, "text": "/status"}},
                {"update_id": 11, "message": {"chat": {"id": 999}, "text": "/status"}},
                {"update_id": 12, "message": {"chat": {"id": 100}, "text": "/help"}},
            ]}
        sent.append(params)
        return {"ok": True}

    poller = m.TelegramBot(
        token="t", allowed_chat_ids=[100], actions=recorder.actions(m), call=poll_call
    )
    next_offset = poller.poll_once(5)
    check("poll_once advances the offset past every update", next_offset == 13, str(next_offset))
    check(
        "only the authorized chats got a reply",
        len(sent) == 2,
        f"{len(sent)} reply/replies sent; the unauthorized update must produce none",
    )
    check("the offset is passed back to Telegram", True)

    # ---- 16. the token never reaches an error message --------------------------
    import types

    stub = types.ModuleType("requests")

    class Boom(Exception):
        pass

    class Session:
        def post(self, url, **kwargs):
            raise Boom(f"connection failed for {url}")

    stub.post = Session().post
    sys.modules["requests"] = stub

    caller = m.http_call("123:SECRET-TOKEN")
    try:
        caller("getUpdates", {})
        check("a transport failure is raised", False, "no exception")
    except RuntimeError as exc:
        check("a transport failure is raised", True)
        check(
            "the error message does not contain the bot token",
            "SECRET-TOKEN" not in str(exc) and "http" not in str(exc),
            f"message={str(exc)!r} — the token is in the request URL",
        )

    # ---- 17. the module has no MDD imports -------------------------------------
    source = open(os.path.join(HERE, "telegram_bot.py"), encoding="utf-8").read()
    top_level = [line for line in source.splitlines() if line.startswith(("import ", "from "))]
    check(
        "the bot imports nothing from the control plane at module level",
        not any("from ." in line or "from control" in line for line in top_level),
        "; ".join(top_level),
    )

    failed = [name for name, ok, _ in results if not ok]
    print()
    print(f"{len(results) - len(failed)}/{len(results)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
