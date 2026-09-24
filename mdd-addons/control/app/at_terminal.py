"""Interactive AT / USSD terminal — command policy and execution.

WHY THIS EXISTS
---------------
When a module misbehaves, the fastest way to find out why is to ask it directly. MDD has no
way to do that: signal quality, registration state, PDP contexts, USSD service codes and
anything the structured panels do not expose are all invisible.

This module holds the logic. The HTTP route lives in `at_terminal_api.py`, so the policy can
be tested without a web framework or a modem.

COMMANDS GO THROUGH MODEMMANAGER, NOT A RAW PORT
------------------------------------------------
`mms_transport.SerialAtChannel` exists and is far faster — it drives a port the gateway owns
outright — but taking a port is exactly what must not happen here: the engine may be holding
the AT port right now, and a debugging tool that takes the line down to answer a question is
worse than no tool. `ModemCommand` goes through ModemManager's `Modem.Command` method, which
shares the modem, so this works **while a line is running**. The cost is about a second per
command, which nobody typing by hand will notice.

WHAT IT REFUSES
---------------
An AT terminal is a loaded gun: some commands damage the module, the SIM, or the port in ways
that survive a reboot. The buckets below are split by *what the damage costs to undo*, not by
how alarming the command looks:

  * **blocked** — permanent or unrecoverable. There is no override.
  * **confirm** — disruptive but recoverable, and sometimes genuinely what you want.
  * **allowed** — everything else: read-only queries, and USSD.

Queries are checked first, before the blocked list, because a query cannot change state.
Blocking `AT+IPR?` would only cost the operator a diagnostic for nothing.
"""

from __future__ import annotations

import re
import subprocess
from dataclasses import dataclass
from typing import Any, Callable, Iterable

# --------------------------------------------------------------------------- policy

#: Commands that can damage the module, the SIM, or the port itself. Every one of these is
#: either irreversible or expensive enough that "I meant to" is not a good enough reason for
#: a web UI to let it through. Matched against the uppercased command.
BLOCKED: tuple[tuple[str, str], ...] = (
    (r"^AT\+EGMR", "IMEI/IMEISV 写入会改写模块身份，且可能永久损坏"),
    (r"^AT\+QPRTPARA", "NV 参数区操作不可逆（=3 恢复出厂会清掉射频校准）"),
    (r"^AT\+CSIM", "原始 SIM APDU 可以永久锁死 SIM 卡"),
    (r"^AT\+CRSM", "受限 SIM 访问同样可以永久锁死 SIM 卡"),
    (r"^AT\+IPR", "修改串口波特率会让这个端口再也连不上"),
    (r"^AT\+(?:QDL|QFOTADL|QDOWNLOAD)", "进入固件下载模式会中断正常通信"),
    (r'^AT\+CLCK="?PN', "网络个性化（SIM 锁）会锁死卡片"),
    (r'^AT\+QCFG="?IMEI', "改写 IMEI 配置属于模块身份变更"),
)

#: Commands that change something real but can be undone. These run only when the caller
#: confirms, and the reason is returned so the confirmation can be informed rather than
#: reflexive.
CONFIRM: tuple[tuple[str, str], ...] = (
    (r"^AT\+CFUN=", "会改变射频状态；AT+CFUN=0 或 =4 会让线路立刻掉线"),
    (r"^AT\+CPIN=", "PIN 连续输错 3 次会永久锁卡，需要 PUK 才能解开"),
    (r"^AT&F", "恢复出厂设置会清掉当前全部配置"),
    (r"^ATZ", "软复位会中断当前会话"),
    (r"^AT\+CLCK=", "会改变卡锁状态"),
    (r"^AT\+CGDCONT=", "会改写 PDP 上下文，影响数据与 IMS"),
    (r"^AT\+QICSGP=", "会改写拨号参数"),
    (r"^AT\+QNWPREFCFG=", "会改写网络制式偏好"),
    (r"^AT\+COPS=", "会手动选网，选错会导致无法注册"),
    (r"^AT\+CMG[SDW]=", "会发送或写入短信，可能产生费用"),
    (r"^AT\+CMGD=", "会删除模块里存储的短信"),
    (r"^AT\+CSCS=", "会改变字符集，可能让后续命令的回复变成乱码"),
)

#: A query ends in `?` (`AT+CSQ?`) or `=?` (`AT+CFUN=?`). A bare trailing `=` is *not* a
#: query — it is a malformed write — which is why the pattern requires the question mark.
_QUERY = re.compile(r"\?\s*$")

#: Commands that only report state and take no `=` at all. This list has to be explicit:
#: "no equals sign" is *not* the same as "read-only", because `ATD` dials, `ATA` answers an
#: incoming call, and `ATH` hangs up — all bare, all real actions, one of them costing money.
BARE_INFO = frozenset(
    {
        "AT",
        "ATI",
        "AT+CGMI",
        "AT+CGMM",
        "AT+CGMR",
        "AT+CGSN",
        "AT+CSQ",
        "AT+CGPADDR",
        "AT+CPAS",
        "AT+CGATT",
        "AT+CREG",
        "AT+CGREG",
        "AT+CEREG",
        "AT+COPS",
        "AT+CGDCONT",
        "AT+CLAC",
        "AT+GCAP",
        "AT+GMI",
        "AT+GMM",
        "AT+GMR",
        "AT+GSN",
        "AT+CFUN",
        "AT+QNWINFO",
        "AT+QCSQ",
        "AT+QENG",
    }
)

#: Shown when a bare command is neither a query nor a known info command, i.e. it is an
#: action such as dialling or answering.
BARE_ACTION_REASON = "需要确认：这会改变通话状态或产生费用"

_BLOCKED_RE = tuple((re.compile(pattern), reason) for pattern, reason in BLOCKED)
_CONFIRM_RE = tuple((re.compile(pattern), reason) for pattern, reason in CONFIRM)

#: `AT`, `AT+XXX`, `AT&F`, `AT^XXX`, optionally with arguments. Anything else is not AT.
#:
#: `;` and `>` are in the bare set because dialling uses them: `ATD<number>;` is a voice call
#: and `ATD><n>` dials from the phonebook. Neither is a shell metacharacter here — the command
#: goes to ModemManager's D-Bus method as a plain string, with no shell anywhere in the path.
_COMMAND_RE = re.compile(r"^AT[\w+&^*#;>]*(?:[=?!].*)?$", re.IGNORECASE)

MAX_COMMAND_LENGTH = 512


@dataclass(frozen=True)
class Verdict:
    """What the policy decided about one command."""

    allowed: bool
    needs_confirm: bool
    reason: str
    #: Uppercased and whitespace-collapsed. AT is case-insensitive and the module echoes what
    #: it was sent, so normalising here keeps the history readable.
    command: str


class AtCommandPolicy:
    """Classifies AT commands by what their damage would cost to undo.

    `allow_actions` relaxes the default. Without it only queries and USSD are permitted,
    which is a genuinely useful mode for a host that should only ever be observed.
    """

    def __init__(self, *, allow_actions: bool = True) -> None:
        self.allow_actions = allow_actions

    def check(self, raw: str) -> Verdict:
        command = " ".join(str(raw or "").split()).upper()
        if not command:
            return Verdict(False, False, "命令为空", command)
        if len(command) > MAX_COMMAND_LENGTH:
            return Verdict(False, False, f"命令过长（上限 {MAX_COMMAND_LENGTH} 字符）", command)
        if not _COMMAND_RE.match(command):
            return Verdict(False, False, "只接受 AT 命令（需以 AT 开头）", command)

        # Blocked first, so that "blocked" means blocked and does not have to be re-audited
        # against every later rule. The cost is that a query on a blocked family is refused
        # too (`AT+IPR?`), which is a diagnostic nobody misses.
        for pattern, reason in _BLOCKED_RE:
            if pattern.match(command):
                return Verdict(False, False, f"已阻止：{reason}", command)

        # A query cannot change state.
        if _QUERY.search(command):
            return Verdict(True, False, "", command)

        # USSD is the reason this feature exists: reading your balance is exactly what a
        # terminal is for. It is a write, but a harmless one, so it stays available even when
        # actions are otherwise disabled.
        if command.startswith("AT+CUSD"):
            return Verdict(True, False, "", command)

        # The explicit list of commands that only report state.
        if command in BARE_INFO:
            return Verdict(True, False, "", command)

        # Everything below changes something, so read-only mode stops here. This check has to
        # come before the confirmation list: "needs confirmation" is not the same as "allowed",
        # and a read-only host must not be able to run a radio change by confirming it.
        if not self.allow_actions:
            return Verdict(False, False, "只读模式：只允许查询命令和 USSD", command)

        for pattern, reason in _CONFIRM_RE:
            if pattern.match(command):
                return Verdict(True, True, f"需要确认：{reason}", command)

        # A write the operator explicitly asked for, with actions enabled.
        if "=" in command:
            return Verdict(True, False, "", command)

        # A bare action: `ATD`, `ATA`, `ATH`. Not a query, not an info command.
        return Verdict(True, True, BARE_ACTION_REASON, command)


DEFAULT_POLICY = AtCommandPolicy()

#: ModemManager's Command method needs a timeout and adds its own slack on top. Six seconds
#: covers a slow registration query without letting a wedged modem hold the request open.
DEFAULT_TIMEOUT = 6.0


# ---------------------------------------------------------------------------- probe

def resolve_modem(
    instances: Iterable[dict],
    instance_id: str,
    runner: Callable[..., Any],
    timeout: float,
) -> tuple[str | None, str | None]:
    """The modem backing this line, or `(None, reason)`.

    The control-plane imports are deferred so this module — and therefore the policy — can be
    imported and tested with nothing installed. `mms_transport` already does exactly this for
    pyserial ("deferred so importing this module never needs it").
    """
    from . import cellular_sms

    instance = next((item for item in instances if str(item.get("id")) == str(instance_id)), None)
    if instance is None:
        return None, "找不到这条线路"
    iccid = str(instance.get("iccid") or "")
    imsi = str(instance.get("imsi") or "")
    if not iccid and not imsi:
        return None, "这条线路还没有 SIM 身份信息（ICCID/IMSI），先让它完成配置"
    return cellular_sms._find_modem(iccid, runner, timeout, imsi=imsi)


def probe(
    instances: list[dict],
    instance_id: str,
    command: str,
    *,
    confirm: bool = False,
    runner: Callable[..., Any] = subprocess.run,
    policy: AtCommandPolicy | None = None,
    timeout: float = DEFAULT_TIMEOUT,
) -> dict[str, Any]:
    """Run one AT command against the modem behind `instance_id`.

    Returns a plain dict the way the rest of the control plane does, so the route stays a
    thin wrapper and this can be driven directly from tests with a fake `runner`.
    """
    active = policy or DEFAULT_POLICY
    verdict = active.check(command)

    result: dict[str, Any] = {
        "ok": False,
        "command": verdict.command,
        "response": "",
        "error": "",
        "blocked": False,
        "needs_confirm": False,
        "reason": verdict.reason,
    }

    if not verdict.allowed:
        result["blocked"] = True
        result["error"] = verdict.reason
        return result

    # The confirmation is enforced here and not only in the UI: this function is the security
    # boundary, and a client that skips the dialog must not get the command anyway.
    if verdict.needs_confirm and not confirm:
        result["needs_confirm"] = True
        result["error"] = verdict.reason
        return result

    modem_path, problem = resolve_modem(instances, instance_id, runner, timeout)
    if not modem_path:
        result["error"] = problem or "没有可用的蜂窝模块"
        return result

    from .mms_transport import ModemCommand

    channel = ModemCommand(modem_path, runner=runner)
    ok, text = channel(verdict.command, int(max(1, timeout)))

    # A module answers an unsupported command with ERROR rather than failing the transport,
    # so `ok` is about the conversation while `text` carries the module's own words either way.
    result["ok"] = ok
    result["response"] = text
    if not ok and not text:
        result["error"] = "模块没有响应（超时）"
    return result
