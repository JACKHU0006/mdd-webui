#!/usr/bin/env python3
"""Behavioural checks for at_terminal.py.

The route cannot be tested without a modem, but everything that decides whether a command
runs can be, and that is where the risk lives. What is worth proving:

  1. **The destructive commands are refused outright.** An AT terminal that will happily take
     `AT+EGMR=` (IMEI write) or `AT+CSIM=` (raw SIM APDU) is a tool that can permanently
     destroy the module or lock the SIM. There is no confirmation path for these.

  2. **Confirmation is enforced server-side, not just in the UI.** The dialog is a
     convenience; if the endpoint ran the command for a client that skipped the dialog, the
     dialog would be decoration. And confirming must not unlock a blocked command.

  3. **Read-only mode is genuinely read-only.** "Needs confirmation" is not the same as
     "allowed" — a read-only host must not be able to change the radio by confirming it.

  4. **A bare command is not automatically a query.** `ATI` reports state, but `ATD` dials
     and `ATA` answers. Treating "no equals sign" as read-only would let both through.

  5. **USSD works even in read-only mode**, because running a service code is the single most
     useful thing an AT terminal does and it is harmless.

  6. **A module's own ERROR is a result, not a transport failure.** "I do not know that
     command" is information the operator needs to see.

Usage: python3 test-at-terminal.py
"""

from __future__ import annotations

import importlib.util
import os
import sys
import types

HERE = os.path.dirname(os.path.abspath(__file__))

results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, ok, detail))
    print(f"{'PASS' if ok else 'FAIL'}  {name}{' — ' + detail if detail else ''}")


class FakeModemCommand:
    """Stands in for `mms_transport.ModemCommand`, recording what was asked of it."""

    calls: list[tuple[str, int]] = []
    reply: tuple[bool, str] = (True, "")

    def __init__(self, modem_path: str, runner=None):
        self.modem_path = modem_path

    def __call__(self, command: str, timeout: int = 5):
        FakeModemCommand.calls.append((command, timeout))
        return FakeModemCommand.reply


def load_module():
    """Load at_terminal.py as `atpkg.at_terminal` inside a synthetic package.

    The module defers `from .mms_transport import ModemCommand` to call time — the same trick
    `mms_transport` uses for pyserial — so importing it needs nothing installed. Loading it
    standalone would make that relative import fail, hence the throwaway package.
    """
    package = types.ModuleType("atpkg")
    package.__path__ = []  # marks it as a package
    sys.modules["atpkg"] = package

    transport = types.ModuleType("atpkg.mms_transport")
    transport.ModemCommand = FakeModemCommand
    sys.modules["atpkg.mms_transport"] = transport

    spec = importlib.util.spec_from_file_location(
        "atpkg.at_terminal", os.path.join(HERE, "at_terminal.py")
    )
    module = importlib.util.module_from_spec(spec)
    # `@dataclass` resolves `sys.modules[cls.__module__]` to read the module namespace for
    # string annotations, so the module must be registered before it is executed.
    sys.modules["atpkg.at_terminal"] = module
    spec.loader.exec_module(module)
    return module


def main() -> int:
    m = load_module()
    policy = m.AtCommandPolicy()
    readonly = m.AtCommandPolicy(allow_actions=False)

    # ---- 1. destructive commands are refused, with no confirmation path ----------
    for command, label in [
        ('AT+EGMR=1,7,"123456789012345"', "IMEI 写入"),
        ("AT+EGMR=0,7", "IMEISV 写入"),
        ("AT+QPRTPARA=3", "恢复出厂 NV"),
        ("AT+CSIM=10,A0A40000023F00", "原始 SIM APDU"),
        ("AT+CRSM=192,28474", "受限 SIM 访问"),
        ("AT+IPR=115200", "修改波特率"),
        ("AT+QDL=1", "固件下载模式"),
        ('AT+CLCK="PN",1,"12345678"', "网络个性化锁"),
        ('AT+QCFG="imei",1', "IMEI 配置写入"),
    ]:
        verdict = policy.check(command)
        check(
            f"{label} is blocked",
            not verdict.allowed and not verdict.needs_confirm,
            f"allowed={verdict.allowed} needs_confirm={verdict.needs_confirm}",
        )

    check(
        "a blocked command explains why",
        "已阻止" in policy.check("AT+IPR=115200").reason,
        policy.check("AT+IPR=115200").reason,
    )
    check(
        "a query on a blocked family is refused too",
        not policy.check("AT+IPR?").allowed,
        "blocked means blocked — a rule with exceptions has to be re-audited against every "
        "later rule, and the lost diagnostic is one nobody misses",
    )

    # ---- 2. disruptive commands need confirmation --------------------------------
    for command, label in [
        ("AT+CFUN=0", "关闭射频"),
        ("AT+CFUN=4", "飞行模式"),
        ("AT+CFUN=1,1", "模块复位"),
        ("AT&F", "恢复出厂设置"),
        ('AT+CPIN="1234"', "输入 PIN"),
        ('AT+CGDCONT=1,"IP","ims"', "改写 PDP 上下文"),
        ('AT+COPS=1,2,"46000"', "手动选网"),
        ('AT+CMGS="+447700900123"', "发送短信"),
        ("AT+CMGD=1,4", "删除短信"),
        ('AT+CSCS="GSM"', "改变字符集"),
    ]:
        verdict = policy.check(command)
        check(
            f"{label} requires confirmation",
            verdict.allowed and verdict.needs_confirm,
            f"allowed={verdict.allowed} needs_confirm={verdict.needs_confirm}",
        )

    check(
        "a confirmation request explains why",
        "需要确认" in policy.check("AT+CFUN=0").reason,
        policy.check("AT+CFUN=0").reason,
    )

    # ---- 3. queries are always allowed -------------------------------------------
    for command in [
        "AT+CSQ?",
        "AT+CREG?",
        "AT+CGDCONT?",
        "AT+CFUN=?",
        "AT+COPS?",
        'AT+QNWPREFCFG="mode_pref"?',
    ]:
        verdict = policy.check(command)
        check(f"query {command!r} is allowed", verdict.allowed and not verdict.needs_confirm,
              verdict.reason)

    # A bare trailing '=' is a malformed write, not a query.
    verdict = policy.check("AT+CFUN=")
    check(
        "a bare trailing '=' is not treated as a query",
        not verdict.allowed or verdict.needs_confirm,
        f"allowed={verdict.allowed} needs_confirm={verdict.needs_confirm}",
    )

    # ---- 4. bare commands: info is allowed, actions are not ----------------------
    for command in ["AT", "ATI", "AT+CGMI", "AT+CGMM", "AT+CGMR", "AT+CGSN", "AT+CSQ",
                    "AT+CGPADDR", "AT+CREG", "AT+QNWINFO"]:
        check(f"bare info {command!r} is allowed", policy.check(command).allowed)

    for command, label in [
        ("ATD+447700900123;", "拨号"),
        ("ATA", "接听"),
        ("ATH", "挂断"),
        # An unrecognised bare command is not provably safe, so it is treated the same way
        # rather than waved through on the assumption that it must be harmless.
        ("AT+NOSUCHTHING", "未知的裸命令"),
    ]:
        verdict = policy.check(command)
        check(
            f"bare action {label} requires confirmation",
            verdict.allowed and verdict.needs_confirm,
            f"allowed={verdict.allowed} needs_confirm={verdict.needs_confirm}",
        )

    # ---- 5. USSD is allowed even in read-only mode -------------------------------
    for command in ['AT+CUSD=1,"*100#",15', 'AT+CUSD=1,"#225#",15']:
        verdict = readonly.check(command)
        check(
            f"{command!r} works in read-only mode",
            verdict.allowed and not verdict.needs_confirm,
            verdict.reason,
        )

    # ---- 6. read-only mode is genuinely read-only --------------------------------
    check(
        "read-only mode refuses a radio change",
        not readonly.check("AT+CFUN=0").allowed,
        "needs-confirmation is not the same as allowed",
    )
    check(
        "read-only mode refuses a reset",
        not readonly.check("AT&F").allowed,
    )
    check(
        "read-only mode allows queries",
        readonly.check("AT+CSQ?").allowed,
    )
    check(
        "read-only mode allows bare info commands",
        readonly.check("ATI").allowed and readonly.check("AT+CGMI").allowed,
        "ATI and AT+CGMI carry no '?', so a query-only rule would wrongly refuse them",
    )
    check(
        "read-only mode refuses a bare action",
        not readonly.check("ATD+447700900123;").allowed,
        "ATD dials and costs money; it is bare, not a query",
    )

    # ---- 7. malformed input is rejected ------------------------------------------
    check("empty input is rejected", not policy.check("").allowed)
    check("whitespace-only input is rejected", not policy.check("   ").allowed)
    check("non-AT input is rejected", not policy.check("rm -rf /").allowed)
    check("a shell-looking string is rejected", not policy.check("AT; ls").allowed)
    check("an over-long command is rejected", not policy.check("AT" + "X" * 600).allowed)

    # ---- 8. normalisation --------------------------------------------------------
    check(
        "commands are uppercased",
        policy.check("at+csq").command == "AT+CSQ",
        policy.check("at+csq").command,
    )
    check(
        "internal whitespace is collapsed",
        policy.check("  AT+CSQ  ").command == "AT+CSQ",
        policy.check("  AT+CSQ  ").command,
    )
    check(
        "lowercase is not a way around the block list",
        not policy.check('at+egmr=1,7,"1"').allowed,
        "case must not matter, or the block list is trivially bypassed",
    )

    # ---- 9. probe(): confirmation is enforced server-side ------------------------
    FakeModemCommand.calls = []
    FakeModemCommand.reply = (True, "+CSQ: 24,99")
    m.resolve_modem = lambda instances, iid, runner, timeout: (
        "/org/freedesktop/ModemManager1/Modem/0",
        None,
    )
    instances = [{"id": "line-1", "iccid": "8944000000000000001"}]

    result = m.probe(instances, "line-1", "AT+CFUN=0")
    check(
        "probe refuses an unconfirmed disruptive command",
        not result["ok"] and result["needs_confirm"],
        f"ok={result['ok']} needs_confirm={result['needs_confirm']}",
    )
    check(
        "the refused command never reached the modem",
        FakeModemCommand.calls == [],
        f"{len(FakeModemCommand.calls)} call(s) made",
    )

    result = m.probe(instances, "line-1", 'AT+EGMR=1,7,"1"', confirm=True)
    check(
        "confirming does not unlock a blocked command",
        result["blocked"] and not result["ok"],
        f"blocked={result['blocked']}",
    )
    check(
        "a blocked command never reached the modem",
        FakeModemCommand.calls == [],
        f"{len(FakeModemCommand.calls)} call(s)",
    )

    # ---- 10. probe(): an allowed command runs ------------------------------------
    result = m.probe(instances, "line-1", "AT+CSQ")
    check("an allowed command runs", result["ok"], result.get("error") or "")
    check("the module's reply is returned", result["response"] == "+CSQ: 24,99", result["response"])
    check(
        "the command reached the modem",
        len(FakeModemCommand.calls) == 1,
        f"{len(FakeModemCommand.calls)} call(s)",
    )
    check(
        "the command is normalised before it is sent",
        FakeModemCommand.calls[0][0] == "AT+CSQ",
        FakeModemCommand.calls[0][0],
    )

    # A confirmed disruptive command does run.
    FakeModemCommand.calls = []
    result = m.probe(instances, "line-1", "AT+CFUN=0", confirm=True)
    check(
        "a confirmed disruptive command runs",
        result["ok"] and FakeModemCommand.calls and FakeModemCommand.calls[0][0] == "AT+CFUN=0",
        str(FakeModemCommand.calls),
    )

    # ---- 11. probe(): a module ERROR is a result, not a transport failure --------
    FakeModemCommand.calls = []
    FakeModemCommand.reply = (True, "ERROR")

    # A query, so it is allowed without confirmation — the point is what happens to the
    # module's answer, not whether the command was permitted.
    result = m.probe(instances, "line-1", "AT+NOSUCHTHING?")
    check(
        "a module ERROR is surfaced verbatim",
        result["response"] == "ERROR",
        f"response={result['response']!r}",
    )
    check(
        "a module ERROR is not reported as a timeout",
        result["error"] == "",
        f"error={result['error']!r}",
    )

    # ---- 12. probe(): no modem is an explanation, not a crash --------------------
    m.resolve_modem = lambda instances, iid, runner, timeout: (None, "没有可用的蜂窝模块")
    result = m.probe(instances, "line-1", "AT+CSQ")
    check(
        "a missing modem is explained",
        not result["ok"] and "蜂窝模块" in result["error"],
        result["error"],
    )

    failed = [name for name, ok, _ in results if not ok]
    print()
    print(f"{len(results) - len(failed)}/{len(results)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
