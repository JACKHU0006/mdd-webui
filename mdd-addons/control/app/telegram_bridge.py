"""Telegram 双向 bot 的接线层（mdd-addons）。

`telegram_bot.py` 是纯逻辑：解析命令、白名单、破坏性命令的一次性确认、长轮询；
它不 import 任何 MDD 模块。这个文件把它的七个动作绑到 control 进程里真实的函数上。

两个实现要点：
* 长轮询用的是阻塞的 `requests`，所以整轮 poll 跑在线程里。动作里的协程不能用
  `run_coroutine_threadsafe` 之外的await 方式 —— 在那个线程里没有事件循环，
  只有主循环才是这些协程的宿主。
* 允许名单 `allowed_chat_ids` 在 MDD 自带设置页里还没有这个字段，而
  `config.update_settings` 是「整个 telegram 段替换」。所以保存设置时必须保留旧值，
  否则前端每存一次设置就会把 bot 悄悄关掉（见 main.py 里的补丁）。
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any, Callable

from . import telegram_bot

log = logging.getLogger("mdd.telegram_bridge")

#: 一轮长轮询失败后等多久再试。网络断掉时不能让循环空转。
POLL_ERROR_SLEEP = 1.0
#: 一个动作最多等多久（eSIM 切换和短信提交都可能慢）。
ACTION_TIMEOUT = 90.0


def allowlist(tg: dict) -> list[str]:
    """把设置里的允许名单读成一个列表。

    既接受数组，也接受「逗号/分号/空格分隔的一串」——设置页里手填一串比手写 JSON
    数组更不容易错。
    """
    raw = (tg or {}).get("allowed_chat_ids")
    if isinstance(raw, (list, tuple)):
        return [str(item).strip() for item in raw if str(item).strip()]
    text = str(raw or "").replace(";", ",").replace(" ", ",")
    return [item.strip() for item in text.split(",") if item.strip()]


class _Actions:
    """bot 的七个动作。全部按「同步签名」暴露，内部把协程丢回主循环。"""

    def __init__(self, loop: asyncio.AbstractEventLoop):
        self._loop = loop

    # ------------------------------------------------------------------ 只读
    def status(self) -> str:
        from . import config as cfg, engine, main as M

        insts = cfg.list_instances()
        if not insts:
            return "还没有线路。先在 WebUI 里加一条 SIM。"
        rows = ["网关状态"]
        for inst in insts:
            iid = str(inst.get("id") or "")
            cached = (getattr(M.hub, "status_cache", {}) or {}).get(iid) or {}
            label = cached.get("label") or ("运行中" if engine.is_running(iid) else "未运行")
            line = f"· {inst.get('name') or iid} [{iid}] {label}"
            if inst.get("msisdn"):
                line += f" {inst['msisdn']}"
            rows.append(line)
        return "\n".join(rows)

    def lines(self) -> str:
        from . import config as cfg, engine

        insts = cfg.list_instances()
        if not insts:
            return "还没有线路。"
        rows = []
        for inst in insts:
            iid = str(inst.get("id") or "")
            rows.append(
                f"{iid} | {inst.get('name') or '—'} | iccid={inst.get('iccid') or '—'} "
                f"| msisdn={inst.get('msisdn') or '—'} "
                f"| {'运行中' if engine.is_running(iid) else '未运行'}"
            )
        return "\n".join(rows)

    def esim_profiles(self, line: str) -> str:
        from . import config as cfg, main as M

        inst = cfg.get_instance(line)
        if not inst:
            inst = next((item for item in cfg.list_instances()
                         if str(item.get("name") or "") == str(line)), None)
        if not inst:
            return f"没有这条线路：{line}"
        entry = M._esim_cache_for_iccid(str(inst.get("iccid") or ""))
        if not entry:
            return "这张卡还没有 eSIM 缓存。去 WebUI 的 eSIM 页面读一次卡即可。"
        rows = [f"{inst.get('name') or inst.get('id')} 的 eSIM 配置："]
        for se in entry.get("ses") or []:
            for prof in se.get("profiles") or []:
                mark = "●" if str(prof.get("profileState")) == "enabled" else "○"
                rows.append(f"{mark} {prof.get('iccid')} {prof.get('profileNickname') or ''}".rstrip())
        return "\n".join(rows) if len(rows) > 1 else "卡上没有可管理的 eSIM 配置。"

    # ------------------------------------------------------------ 需确认执行
    def _wait(self, factory: Callable[[], Any]) -> Any:
        """把协程丢回主循环并等结果（当前线程里没有事件循环）。"""
        coro = factory()
        return asyncio.run_coroutine_threadsafe(coro, self._loop).result(ACTION_TIMEOUT)

    def send_sms(self, line: str, to: str, text: str) -> str:
        from . import main as M

        res = self._wait(lambda: M.send_sms_on_line(line, to, text, "auto"))
        if not isinstance(res, dict):
            return f"发送返回了意外结果：{res}"
        if res.get("ok"):
            return f"已提交（{res.get('transport') or 'auto'}）：{to}"
        if res.get("uncertain"):
            return f"已提交但没收到确认：{res.get('error') or '未知原因'}"
        return "没发出去：" + str(res.get("error") or res.get("message") or "未知原因")

    def query_balance(self, line: str) -> str:
        from . import allowance

        snapshot = allowance.reconcile(line)
        if not snapshot:
            return "还没有余额记录。先在线路的保号页里配一条余额查询规则。"
        parts = [f"{key}={snapshot[key]}" for key in ("balance", "usage", "valid_until")
                 if snapshot.get(key)]
        return "；".join(parts) or "有记录，但字段都是空的。"

    def switch_profile(self, line: str, iccid: str) -> str:
        from . import main as M

        res = self._wait(lambda: M.api_esim_enable(iccid, {}))
        if isinstance(res, dict) and res.get("ok"):
            return f"已切到 {iccid}"
        return f"切换失败：{res}"

    def set_wfc(self, line: str, on: bool) -> str:
        from . import config as cfg, main as M

        inst = cfg.get_instance(line)
        if not inst:
            return f"没有这条线路：{line}"
        if on:
            cfg.upsert_instance({"id": line, "enabled": True})
            self._wait(lambda: M.api_instance_start(line))
            return f"{line} 的 VoWiFi 已启动"
        cfg.upsert_instance({"id": line, "enabled": False})
        self._wait(lambda: M._stop_instance(line, "telegram_wfc_off"))
        return f"{line} 的 VoWiFi 已停止"


class Service:
    """持有长轮询任务，供 lifespan 启停、供设置页看状态。"""

    def __init__(self) -> None:
        self.task: asyncio.Task | None = None
        self.bot: telegram_bot.TelegramBot | None = None
        self.offset: int | None = None
        self.error = ""
        self._loop: asyncio.AbstractEventLoop | None = None

    def _settings(self) -> dict:
        from . import config as cfg

        return cfg.get_settings().get("telegram") or {}

    def status(self) -> dict:
        tg = self._settings()
        token = str(tg.get("bot_token") or "")
        return {
            "enabled": bool(tg.get("enabled")),
            "has_token": bool(token),
            "allowlist": allowlist(tg),
            "listening": bool(self.task and not self.task.done()),
            "last_error": self.error,
            "commands": [f"/{name}" for name in telegram_bot.COMMANDS],
            "poll_timeout_seconds": telegram_bot.POLL_TIMEOUT_SECONDS,
        }

    def start(self, app=None) -> bool:
        """按当前设置起长轮询。token 与白名单缺一不可；缺了就什么都不做。"""
        self.stop()
        tg = self._settings()
        token = str(tg.get("bot_token") or "")
        allowed = allowlist(tg)
        if not (bool(tg.get("enabled")) and token and allowed):
            log.info("telegram bot 未启动：enabled=%s token=%s allowlist=%d",
                     bool(tg.get("enabled")), bool(token), len(allowed))
            return False
        try:
            self._loop = asyncio.get_running_loop()
        except RuntimeError:
            log.warning("telegram bot 启动失败：不在事件循环里")
            return False
        actions = telegram_bot.GatewayActions(
            status=_Actions(self._loop).status,
            lines=_Actions(self._loop).lines,
            esim_profiles=_Actions(self._loop).esim_profiles,
            send_sms=_Actions(self._loop).send_sms,
            query_balance=_Actions(self._loop).query_balance,
            switch_profile=_Actions(self._loop).switch_profile,
            set_wfc=_Actions(self._loop).set_wfc,
        )
        self.bot = telegram_bot.TelegramBot(
            token=token, allowed_chat_ids=allowed, actions=actions,
            call=telegram_bot.http_call(token))
        self.offset = None
        self.error = ""
        self.task = asyncio.create_task(self._loop_poll(), name="telegram-bot")
        log.info("telegram bot 已启动（白名单 %d 个 chat）", len(allowed))
        return True

    async def _loop_poll(self) -> None:
        while True:
            try:
                self.offset = await asyncio.to_thread(self.bot.poll_once, self.offset)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - 一轮失败不该结束整个循环
                self.error = type(exc).__name__
                log.warning("telegram 长轮询失败：%s", type(exc).__name__)
                await asyncio.sleep(POLL_ERROR_SLEEP)

    def stop(self) -> None:
        if self.task and not self.task.done():
            self.task.cancel()
        self.task = None
        self.bot = None


SERVICE = Service()
