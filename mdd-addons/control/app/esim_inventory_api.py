"""HTTP route for the multi-eUICC inventory.

Kept apart from `esim_inventory.py` so the assembly logic can be imported and tested with no
web framework and no card. This file is the only part that needs FastAPI.

INSTALLING THIS
---------------
Two lines in `control/app/main.py`, next to the other module imports and route registrations:

    from . import esim_inventory_api
    ...
    app.include_router(esim_inventory_api.router)

Nothing else in the control plane changes.
"""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, HTTPException

from . import cfg, lpa, sim
from .esim_inventory import build_inventory

router = APIRouter()


def _line_for_eid(eid: str) -> str | None:
    """Which line is using this eUICC, matched on the profiles it holds.

    A line stores the ICCID it provisioned from, not the EID, so the link has to go through
    the profile list. Best-effort: an unmatched card simply reports no line rather than
    guessing at one.
    """
    try:
        instances = cfg.list_instances()
    except Exception:  # noqa: BLE001
        return None
    for instance in instances:
        iccid = str(instance.get("iccid") or "")
        if iccid and iccid in eid:
            return str(instance.get("id"))
    return None


def _collect(refresh: bool) -> dict:
    """Read the cache, and optionally every reader, then assemble the inventory."""
    readers: list[str] = []
    try:
        readers = list(sim.list_readers() or [])
    except Exception:  # noqa: BLE001 -- no PC/SC stack is an empty inventory, not a 500
        readers = []

    cached = _cache()
    read_reader = None
    if refresh:
        def read_reader(name: str, index: int) -> dict:  # noqa: ANN001
            # `load_all_ses` is the same call `/api/esim/chip` makes, so a card read here is
            # cached exactly as it would be from the eSIM page.
            return lpa.load_all_ses(name, index) or {}

    return build_inventory(
        readers=readers,
        cached=cached,
        refresh=refresh,
        read_reader=read_reader,
        line_for_eid=_line_for_eid,
    )


def _cache() -> dict:
    """The eSIM cache, via the control plane's own reader.

    Imported lazily because it lives in `main`, which imports this module — the same reason
    `notify_channels` defers its import of `notify_push`.
    """
    from . import main

    return main._esim_cache_load()


@router.get("/api/esim/inventory")
async def api_esim_inventory(refresh: bool = False):
    """Every eUICC the gateway knows about.

    Defaults to the cache, which is fast and touches no card. `?refresh=1` reads every reader:
    that is exclusive and serialised (lpac is single-threaded), and it takes the reader away
    from any running engine, so it is a deliberate action rather than something a page load
    does on its own.
    """
    if not lpa.lpac_available() and refresh:
        raise HTTPException(409, "lpac 不可用，无法读卡；可以先看缓存")
    # A full refresh reads every reader in sequence and can take several seconds per card, so it
    # must not run on the event loop.
    return await asyncio.to_thread(_collect, bool(refresh))
