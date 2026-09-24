"""HTTP route for the AT / USSD terminal.

Kept apart from `at_terminal.py` so the policy and execution logic can be imported and tested
with no web framework installed. This file is the only part that needs FastAPI.

INSTALLING THIS
---------------
Two lines in `control/app/main.py` — an import next to the other `from . import ...` lines,
and the `include_router` call next to the other route registrations:

    from . import at_terminal_api            # <- with the other module imports
    ...
    app.include_router(at_terminal_api.router)   # <- after the app is created

Nothing else in the control plane changes.
"""

from __future__ import annotations

import asyncio
import os

from fastapi import APIRouter, HTTPException

from . import cfg
from .at_terminal import AtCommandPolicy, probe

router = APIRouter()

#: Whether commands that change state are permitted at all. Defaults to on, because a
#: read-only terminal cannot run a USSD service code, which is the main thing operators reach
#: for. Set `MDD_AT_TERMINAL_ACTIONS=0` on a host that should only ever be observed.
_ACTIONS_ENV = "MDD_AT_TERMINAL_ACTIONS"


def _actions_enabled() -> bool:
    return str(os.environ.get(_ACTIONS_ENV, "1")).strip().lower() not in {"0", "false", "no"}


@router.post("/api/instances/{iid}/at")
async def api_at_command(iid: str, body: dict):
    """Run one AT command against the modem behind this line.

    Body: `{"command": "AT+CSQ", "confirm": false}`.

    `confirm` acknowledges a command the policy classified as disruptive. It is required only
    for those; a query or a USSD code needs no confirmation.
    """
    command = str((body or {}).get("command") or "")
    confirm = bool((body or {}).get("confirm"))

    policy = AtCommandPolicy(allow_actions=_actions_enabled())

    # ModemManager's Command method blocks, and a wedged modem can take seconds to answer, so
    # it must not run on the event loop.
    result = await asyncio.to_thread(
        probe,
        cfg.list_instances(),
        str(iid),
        command,
        confirm=confirm,
        policy=policy,
    )

    if result.get("blocked"):
        # 403 rather than 200-with-a-flag: a refused command did not run, and a client should
        # not be able to mistake the refusal for a result. The body is the bare reason, so a
        # client can frame it ("refused: ...") without the message reading as a double prefix.
        raise HTTPException(403, result["reason"])
    return result
