"""Multi-eUICC inventory.

MDD manages one card at a time: `/api/esim/chip` reads one reader and returns that card's
profiles. With several eUICCs (a soldered one, a removable one, a dual-SE card that presents
two secure elements) there is no single place that answers "what eUICCs do I have, and which
line is on which?".

THREE THINGS THIS MODULE IS CAREFUL ABOUT
-----------------------------------------

**1. Reading is exclusive and serialised, so it is opt-in.** lpac is single-threaded across
readers, and a read takes the reader away from the engine. Reading every reader on every page
load would interrupt running lines to answer a question nobody asked. The default is therefore
*the cache*, and `refresh` is a deliberate action — the same split the eSIM page already makes
between "read card" and "read cache".

**2. The cache is keyed by EID, so a removed card leaves an entry behind.** A cached eUICC
whose reader no longer reports it is not present, but nothing deletes the record. Reporting it
as if it were there would be the most misleading thing this module could do, so each entry
carries `present`: True when just read, **None when only known from the cache** — "unknown"
rather than a guess in either direction.

**3. "No eUICC in this reader" is not a failure.** A plain USIM in a reader is the normal
case, and a failed read is not. Conflating them would fill the page with errors on any host
that has an ordinary SIM inserted.

The logic is a pure function over injected data (`read_reader`), so it is testable without
readers, without lpac, and without a card.
"""

from __future__ import annotations

import time
from typing import Any, Callable

#: How old a cached reading may be before the UI should say so rather than imply it is current.
STALE_AFTER_SECONDS = 6 * 3600


def _profile_counts(ses: list) -> tuple[int, int, list[str]]:
    """`(profiles, enabled, errors)` across every secure element of one card."""
    profiles = 0
    enabled = 0
    errors: list[str] = []
    for se in ses or []:
        if not isinstance(se, dict):
            continue
        if se.get("error"):
            errors.append(str(se["error"]))
        for profile in se.get("profiles") or []:
            if not isinstance(profile, dict):
                continue
            profiles += 1
            # lpac reports `enabled`/`disabled` and is case-insensitive about it.
            if str(profile.get("profileState") or "").strip().lower() == "enabled":
                enabled += 1
    return profiles, enabled, errors


def _entry(
    *,
    eid: str,
    ses: list,
    imei: str,
    reader: str | None,
    present: bool | None,
    read_at: int | None,
    now: int,
    line: str | None = None,
) -> dict[str, Any]:
    profiles, enabled, errors = _profile_counts(ses)
    age = None if not read_at else max(0, now - int(read_at))
    return {
        "eid": eid,
        "imei": imei or "",
        "reader": reader or "",
        "present": present,
        "ses": len([se for se in (ses or []) if isinstance(se, dict)]),
        "profiles": profiles,
        "enabled": enabled,
        "errors": errors,
        "read_at": read_at,
        "age_seconds": age,
        # A cached reading older than this is still shown, but flagged: the operator needs to
        # know whether they are looking at the card or at their memory of it.
        "stale": bool(age is not None and age > STALE_AFTER_SECONDS),
        "line": line,
    }


def build_inventory(
    *,
    readers: list[str],
    cached: dict,
    now: int | None = None,
    refresh: bool = False,
    read_reader: Callable[[str, int], dict] | None = None,
    line_for_eid: Callable[[str], str | None] | None = None,
) -> dict[str, Any]:
    """Assemble the inventory.

    `read_reader(name, index)` returns `{"ses": [...]}` for one reader and is only called when
    `refresh` is set. It is injected so this function has no I/O of its own.
    """
    stamp = int(time.time()) if now is None else int(now)
    euiccs: dict[str, dict] = {}
    errors: list[str] = []
    seen_eids: set[str] = set()

    if refresh and read_reader is not None:
        # Sequential on purpose: lpac is single-threaded across readers, and a read takes the
        # reader from the engine. Running these concurrently would produce interleaved
        # failures rather than a faster answer.
        for index, name in enumerate(readers):
            try:
                payload = read_reader(name, index) or {}
            except Exception as exc:  # noqa: BLE001
                errors.append(f"{name}：{type(exc).__name__}")
                continue
            ses = payload.get("ses") or []
            eid = next((str(se.get("eid")) for se in ses if isinstance(se, dict) and se.get("eid")), "")
            if not eid:
                # No EID means no eUICC here. A plain USIM is not an error, so it is recorded
                # as an empty reader rather than as a failure.
                continue
            seen_eids.add(eid)
            euiccs[eid] = _entry(
                eid=eid,
                ses=ses,
                imei=str(payload.get("imei") or ""),
                reader=name,
                present=True,
                read_at=stamp,
                now=stamp,
                line=(line_for_eid or (lambda _eid: None))(eid),
            )

    # Everything else comes from the cache, including cards that were just read (in which case
    # the freshly read entry above wins).
    for eid, entry in (cached or {}).items():
        if not isinstance(entry, dict):
            continue
        if eid in euiccs:
            continue
        euiccs[eid] = _entry(
            eid=str(eid),
            ses=entry.get("ses") or [],
            imei=str(entry.get("imei") or ""),
            reader=None,
            # Known only from the cache: we cannot claim it is present, and we must not claim
            # it is gone either. `None` is the honest answer.
            present=None,
            read_at=entry.get("ts"),
            now=stamp,
            line=(line_for_eid or (lambda _eid: None))(str(eid)),
        )

    ordered = sorted(euiccs.values(), key=lambda item: (item["reader"] == "", item["eid"]))
    return {
        "ok": True,
        "refreshed": bool(refresh),
        "now": stamp,
        "readers": list(readers),
        "euiccs": ordered,
        "count": len(ordered),
        # How many cached cards were not reported by any reader this pass. Only meaningful
        # after a refresh; without one it is 0 because nothing was checked.
        "unseen": len([item for item in ordered if refresh and item["eid"] not in seen_eids]),
        "errors": errors,
    }
