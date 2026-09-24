"""Bidirectional Telegram bot.

MDD pushes to Telegram and deliberately does not listen: `notify_push.send_telegram` is
one-way, and the gateway's position is that it does not accept remote control commands. This
module adds the listening half, so the security boundary is the work — not the commands.

FOUR THINGS ARE LOAD-BEARING
----------------------------

**1. An empty allowlist means nobody, not everybody.** `allowed_chat_ids` is the only thing
standing between a bot token and anyone who finds the bot. The failure mode of "no
configuration yet" must be silence, so `authorize()` returns False for an empty set and the
gateway refuses to start the listener at all unless at least one chat is listed. Getting this
backwards — treating an unset list as "unrestricted" — is the single worst bug this module
could have, and it is the first thing the tests check.

**2. An unauthorized chat gets no reply at all.** Not "not authorized" — silence. A reply
confirms the bot is live and invites guessing. The rejection is logged server-side instead.

**3. Anything that costs money or interrupts a line needs a one-time confirmation.** Sending
an SMS bills the account; an eSIM switch drops the line; a radio change does too. The
confirmation carries the *specific* consequence, because "are you sure?" without a reason
trains people to click through. Tokens are single-use, expire, and are bound to the chat that
asked — a token leaked into a group cannot be redeemed by someone else.

**4. Long polling, not a webhook.** The gateway usually sits behind NAT or a Cloudflare
Tunnel and has no inbound URL to give Telegram. Long polling needs nothing but outbound
HTTPS, which the notification channels already require.

The bot token is never logged and never included in an exception message: it is part of the
request URL, so the default `requests` exception text leaks it.
"""

from __future__ import annotations

import logging
import secrets
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Iterable

log = logging.getLogger(__name__)

#: How long a confirmation token stays valid. Long enough to read the warning and decide,
#: short enough that a stale token cannot be redeemed much later by accident.
CONFIRM_TTL_SECONDS = 120

#: Minimum gap between two *executed* destructive commands in the same chat. A confirmation
#: stops the accidental case; this stops the repeated case.
DESTRUCTIVE_COOLDOWN_SECONDS = 30

#: Telegram's own limit is 4096; staying under it keeps a reply from being silently truncated.
MAX_REPLY_LENGTH = 3500

#: Long-poll timeout handed to getUpdates. Telegram holds the request open this long.
POLL_TIMEOUT_SECONDS = 25


# ------------------------------------------------------------------------- authorization

def authorize(chat_id: Any, allowed_chat_ids: Iterable[Any]) -> bool:
    """True only for an explicitly listed chat.

    FAIL CLOSED. An empty or missing allowlist authorises nobody. The alternative reading —
    "no list means no restriction" — would expose every command to anyone who finds the bot,
    and it is exactly the sort of default that only gets noticed after it matters.
    """
    allowed = {str(item).strip() for item in (allowed_chat_ids or []) if str(item).strip()}
    if not allowed:
        return False
    return str(chat_id).strip() in allowed


# -------------------------------------------------------------------------- commands

@dataclass(frozen=True)
class Command:
    name: str
    args: list[str]
    raw: str


def parse_command(text: str) -> Command | None:
    """Parse `/name args…`. Returns None when the text is not a command.

    Telegram sends the command with the bot's own @mention appended in groups
    (`/status@my_bot`), so the mention is stripped — otherwise every command would look
    unknown in a group chat and work only in a private one.
    """
    raw = str(text or "").strip()
    if not raw.startswith("/"):
        return None
    head, _, rest = raw.partition(" ")
    name = head[1:].split("@", 1)[0].strip().lower()
    if not name:
        return None
    return Command(name=name, args=rest.split() if rest.strip() else [], raw=raw)


@dataclass(frozen=True)
class CommandSpec:
    name: str
    summary: str
    usage: str
    #: True when the command needs a confirmation before it runs.
    destructive: bool
    #: The consequence shown in the confirmation. Empty for read-only commands.
    consequence: str = ""


COMMANDS: dict[str, CommandSpec] = {
    "help": CommandSpec("help", "显示所有命令", "/help", destructive=False),
    "status": CommandSpec("status", "网关整体状态", "/status", destructive=False),
    "lines": CommandSpec("lines", "列出所有线路", "/lines", destructive=False),
    "esim": CommandSpec("esim", "列出某条线路的 eSIM 配置", "/esim <线路>", destructive=False),
    "sms": CommandSpec(
        "sms",
        "发一条短信",
        "/sms <线路> <号码> <内容>",
        destructive=True,
        consequence="会真的发出一条短信，运营商会计费",
    ),
    "balance": CommandSpec(
        "balance",
        "查询余额",
        "/balance <线路>",
        destructive=True,
        consequence="查询余额会向运营商发送一条短信，可能计费",
    ),
    "switch": CommandSpec(
        "switch",
        "切换 eSIM 配置",
        "/switch <线路> <ICCID>",
        destructive=True,
        consequence="切换配置会让这条线路中断，需要重新建立隧道",
    ),
    "wfc": CommandSpec(
        "wfc",
        "开关 Wi-Fi Calling",
        "/wfc <线路> on|off",
        destructive=True,
        consequence="会改变射频状态，线路会短暂中断",
    ),
}


def help_text() -> str:
    lines = ["MDD 网关", ""]
    for spec in COMMANDS.values():
        lines.append(f"{spec.usage} — {spec.summary}")
    lines.extend(["", "/confirm <令牌> — 执行上一条待确认的命令", "/cancel — 取消待确认的命令"])
    return "\n".join(lines)


# ---------------------------------------------------------------------- confirmations

@dataclass
class Pending:
    token: str
    chat_id: str
    name: str
    args: list[str]
    consequence: str
    expires_at: float


class ConfirmationStore:
    """One pending destructive action per chat, redeemable once, before it expires.

    One-at-a-time is deliberate: a queue would let an operator accumulate confirmations they
    no longer remember asking for, and the whole point of the gate is that the action is still
    in mind when it runs.
    """

    def __init__(self, *, ttl: float = CONFIRM_TTL_SECONDS, clock: Callable[[], float] = time.monotonic):
        self._ttl = ttl
        self._clock = clock
        self._pending: dict[str, Pending] = {}
        self._lock = threading.RLock()

    def issue(self, chat_id: Any, name: str, args: list[str], consequence: str) -> Pending:
        chat = str(chat_id)
        # 4 bytes of entropy is plenty: the token is single-use, expires in two minutes, and
        # is useless to anyone but the chat that asked for it.
        pending = Pending(
            token=secrets.token_hex(4),
            chat_id=chat,
            name=name,
            args=list(args),
            consequence=consequence,
            expires_at=self._clock() + self._ttl,
        )
        with self._lock:
            self._pending[chat] = pending
        return pending

    def consume(self, chat_id: Any, token: str) -> Pending | None:
        """Redeem a token. Returns None when it is wrong, expired, or already used."""
        chat = str(chat_id)
        with self._lock:
            pending = self._pending.get(chat)
            if pending is None:
                return None
            if not secrets.compare_digest(pending.token, str(token or "").strip()):
                return None
            # Single use: removed whether or not the action then succeeds. A retry has to be a
            # new request, so the operator re-reads the consequence.
            del self._pending[chat]
            if self._clock() > pending.expires_at:
                return None
            return pending

    def cancel(self, chat_id: Any) -> bool:
        with self._lock:
            return self._pending.pop(str(chat_id), None) is not None

    def peek(self, chat_id: Any) -> Pending | None:
        """The live pending action, if any — used for the cooldown and for diagnostics."""
        with self._lock:
            pending = self._pending.get(str(chat_id))
            if pending and self._clock() > pending.expires_at:
                return None
            return pending


# ---------------------------------------------------------------------------- actions

@dataclass
class GatewayActions:
    """What the bot is allowed to do, injected as callables.

    The bot holds no MDD imports, so it can be tested without a control plane — and, more to
    the point, the set of things it can reach is a written-down list rather than whatever
    happens to be importable.
    """

    status: Callable[[], str]
    lines: Callable[[], str]
    esim_profiles: Callable[[str], str]
    send_sms: Callable[[str, str, str], str]
    query_balance: Callable[[str], str]
    switch_profile: Callable[[str, str], str]
    set_wfc: Callable[[str, bool], str]


def _require_args(command: Command, count: int) -> str | None:
    if len(command.args) < count:
        spec = COMMANDS.get(command.name)
        usage = spec.usage if spec else f"/{command.name}"
        return f"参数不足。用法：{usage}"
    return None


def run_command(actions: GatewayActions, command: Command) -> str:
    """Execute a read-only command. Destructive ones never reach here directly."""
    if command.name == "status":
        return actions.status()
    if command.name == "lines":
        return actions.lines()
    if command.name == "esim":
        problem = _require_args(command, 1)
        return problem or actions.esim_profiles(command.args[0])
    return help_text()


def run_destructive(actions: GatewayActions, name: str, args: list[str]) -> str:
    """Execute a confirmed destructive command."""
    if name == "sms":
        return actions.send_sms(args[0], args[1], " ".join(args[2:]))
    if name == "balance":
        return actions.query_balance(args[0])
    if name == "switch":
        return actions.switch_profile(args[0], args[1])
    if name == "wfc":
        return actions.set_wfc(args[0], args[1].lower() in {"on", "1", "true", "yes", "开"})
    return "未知命令。"


# -------------------------------------------------------------------------------- bot

class TelegramBot:
    """Long-polling listener.

    `call` is the only I/O: a function `(method, params) -> dict`. Injecting it keeps the
    whole command surface testable without a network or a token.
    """

    def __init__(
        self,
        *,
        token: str,
        allowed_chat_ids: Iterable[Any],
        actions: GatewayActions,
        call: Callable[[str, dict], dict],
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._token = token
        self._allowed = [str(item).strip() for item in (allowed_chat_ids or []) if str(item).strip()]
        self._actions = actions
        self._call = call
        self._clock = clock
        self._confirmations = ConfirmationStore(clock=clock)
        self._last_destructive: dict[str, float] = {}

    @property
    def enabled(self) -> bool:
        """False when there is no token or no allowlist.

        An empty allowlist disables the listener entirely rather than accepting everyone —
        the bot simply does not run until it is told who may talk to it.
        """
        return bool(str(self._token or "").strip()) and bool(self._allowed)

    def _reply(self, chat_id: Any, text: str) -> None:
        body = text if len(text) <= MAX_REPLY_LENGTH else text[: MAX_REPLY_LENGTH - 20] + "\n…（已截断）"
        try:
            self._call("sendMessage", {"chat_id": str(chat_id), "text": body,
                                       "disable_web_page_preview": True})
        except Exception as exc:  # noqa: BLE001
            # Type only: the token is in the request URL, so a full exception would leak it.
            log.warning("telegram reply failed: %s", type(exc).__name__)

    def handle_update(self, update: dict) -> str | None:
        """Process one update. Returns the reply text, or None when nothing was said.

        Returning rather than sending keeps the decision logic separate from the transport,
        which is what makes it testable; `poll_once` does the sending.
        """
        message = (update or {}).get("message") or (update or {}).get("edited_message") or {}
        chat = message.get("chat") or {}
        chat_id = chat.get("id")
        if chat_id is None:
            return None

        # Silence for anyone not on the list. A reply would confirm the bot is live.
        if not authorize(chat_id, self._allowed):
            log.warning("telegram: ignoring message from unauthorised chat %s", chat_id)
            return None

        command = parse_command(message.get("text") or "")
        if command is None:
            # Plain text is not an error, but it is also not a command; a one-line nudge beats
            # silence, because a user who typed something deserves to know why nothing happened.
            return "我只认命令。发 /help 看列表。"

        if command.name == "help":
            return help_text()

        if command.name == "cancel":
            return "已取消。" if self._confirmations.cancel(chat_id) else "没有待确认的命令。"

        if command.name == "confirm":
            return self._confirm(chat_id, command)

        spec = COMMANDS.get(command.name)
        if spec is None:
            return f"没有这个命令：/{command.name}\n\n{help_text()}"

        if not spec.destructive:
            return run_command(self._actions, command)

        # ---- destructive: argue first, act later ----
        problem = self._check_destructive_args(command)
        if problem:
            return problem

        now = self._clock()
        last = self._last_destructive.get(str(chat_id))
        if last is not None and now - last < DESTRUCTIVE_COOLDOWN_SECONDS:
            wait = int(DESTRUCTIVE_COOLDOWN_SECONDS - (now - last)) + 1
            return f"刚执行过一条会改变状态的命令，请等 {wait} 秒再试。"

        pending = self._confirmations.issue(chat_id, command.name, command.args, spec.consequence)
        return (
            f"⚠️ {spec.consequence}\n\n"
            f"命令：{command.raw}\n"
            f"确认执行：/confirm {pending.token}\n"
            f"取消：/cancel\n"
            f"（{CONFIRM_TTL_SECONDS} 秒内有效，只能用一次）"
        )

    def _check_destructive_args(self, command: Command) -> str | None:
        if command.name == "sms":
            if len(command.args) < 3:
                return "参数不足。用法：/sms <线路> <号码> <内容>"
        elif command.name == "switch":
            problem = _require_args(command, 2)
            if problem:
                return problem
        elif command.name == "wfc":
            if len(command.args) < 2 or command.args[1].lower() not in {
                "on", "off", "1", "0", "true", "false", "yes", "no", "开", "关",
            }:
                return "参数不对。用法：/wfc <线路> on|off"
        else:
            return _require_args(command, 1)
        return None

    def _confirm(self, chat_id: Any, command: Command) -> str:
        if not command.args:
            return "用法：/confirm <令牌>"
        pending = self._confirmations.consume(chat_id, command.args[0])
        if pending is None:
            return "这个令牌无效、已过期，或者已经被用过了。请重新发起那条命令。"

        spec = COMMANDS.get(pending.name)
        if spec is None:
            return "待确认的命令已经不存在了。"
        problem = self._check_destructive_args(Command(pending.name, pending.args, ""))
        if problem:
            return problem

        try:
            result = run_destructive(self._actions, pending.name, pending.args)
        except Exception as exc:  # noqa: BLE001
            log.warning("telegram command %s failed: %s", pending.name, type(exc).__name__)
            return f"执行失败：{type(exc).__name__}"

        self._last_destructive[str(chat_id)] = self._clock()
        return result

    def poll_once(self, offset: int | None = None) -> int | None:
        """One long-poll round. Returns the next offset, or None when nothing arrived."""
        params: dict[str, Any] = {"timeout": POLL_TIMEOUT_SECONDS}
        if offset is not None:
            params["offset"] = offset
        response = self._call("getUpdates", params)
        updates = response.get("result") if isinstance(response, dict) else None
        if not isinstance(updates, list):
            return offset
        next_offset = offset
        for update in updates:
            if not isinstance(update, dict):
                continue
            update_id = update.get("update_id")
            if isinstance(update_id, int):
                next_offset = update_id + 1
            try:
                reply = self.handle_update(update)
            except Exception as exc:  # noqa: BLE001
                log.warning("telegram update failed: %s", type(exc).__name__)
                continue
            if reply:
                chat = ((update.get("message") or {}).get("chat") or {}).get("id")
                if chat is not None:
                    self._reply(chat, reply)
        return next_offset


# ------------------------------------------------------------------- transport helper

def http_call(token: str, *, api_base: str = "https://api.telegram.org",
              timeout: float = POLL_TIMEOUT_SECONDS + 10,
              session_factory: Callable[[], Any] | None = None) -> Callable[[str, dict], dict]:
    """Build the real `call` function.

    Kept apart from the bot so the bot never imports `requests`, and so the token lives in one
    place. The exception is re-raised as a bare `RuntimeError`: `requests` puts the full URL —
    token and all — into its message, and that message would end up in a log.
    """
    import requests

    def call(method: str, params: dict) -> dict:
        url = f"{api_base}/bot{token}/{method}"
        session = session_factory() if session_factory else requests
        try:
            response = session.post(url, json=params, timeout=timeout)
            response.raise_for_status()
            return response.json()
        except Exception:  # noqa: BLE001
            raise RuntimeError(f"Telegram {method} 请求失败") from None

    return call


INSTALL_NOTES = """
Wire it up in `control/app/main.py`:

  1. Read the configuration. It lives under the existing `telegram` settings section, so the
     token is shared with the push channel and only the allowlist is new:

         tg = (cfg.get_settings().get("telegram") or {})
         allowed = tg.get("allowed_chat_ids") or []

  2. Build the actions from the functions the HTTP routes already call, so the bot and the
     console cannot diverge:

         from . import telegram_bot

         actions = telegram_bot.GatewayActions(
             status=lambda: _telegram_status(),
             lines=lambda: _telegram_lines(),
             esim_profiles=lambda line: _telegram_esim(line),
             send_sms=lambda line, to, text: _telegram_send_sms(line, to, text),
             query_balance=lambda line: _telegram_balance(line),
             switch_profile=lambda line, iccid: _telegram_switch(line, iccid),
             set_wfc=lambda line, on: _telegram_wfc(line, on),
         )

  3. Start the loop as a background task on startup. It is a no-op when the token or the
     allowlist is missing:

         bot = telegram_bot.TelegramBot(
             token=str(tg.get("bot_token") or ""),
             allowed_chat_ids=allowed,
             actions=actions,
             call=telegram_bot.http_call(str(tg.get("bot_token") or "")),
         )
         if bot.enabled:
             app.state.telegram_task = asyncio.create_task(_telegram_loop(bot))

  4. `_telegram_loop` is a plain `while True` that calls `bot.poll_once(offset)`, stores the
     returned offset, and sleeps a second on error so a dead network does not spin.

Nothing else changes. The push channel keeps working exactly as before.
"""
