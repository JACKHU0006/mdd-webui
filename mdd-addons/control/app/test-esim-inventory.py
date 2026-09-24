#!/usr/bin/env python3
"""Behavioural checks for esim_inventory.py.

The inventory is a read-only view, so the risk is not damage — it is a page that confidently
says something untrue about hardware the operator cannot see. What is worth proving:

  1. **A cached eUICC is not reported as present.** The cache is keyed by EID and nothing
     removes an entry when a card is taken out, so the naive implementation shows a card that
     is sitting in a drawer. `present` must be `None` (unknown) from the cache and `True` only
     from a read.

  2. **A reader with a plain USIM is not an error.** No EID is the normal case for a non-eUICC
     card. Recording it as a failure would fill the page with errors on most hosts.

  3. **Reads are sequential and opt-in.** lpac is single-threaded and a read takes the reader
     from the engine, so nothing is read unless `refresh` is set, and the reads must not be
     issued concurrently.

  4. **One reader failing does not lose the others.** A partial answer with the failure named
     beats no answer.

  5. **Stale readings are flagged, not hidden.** An old cache entry is still shown, because it
     is the best information available, but it is marked.

Usage: python3 test-esim-inventory.py
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
        "esim_inventory", os.path.join(HERE, "esim_inventory.py")
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules["esim_inventory"] = module
    spec.loader.exec_module(module)
    return module


def se(eid, profiles=(), error=None):
    return {
        "eid": eid,
        "error": error,
        "profiles": [{"iccid": iccid, "profileState": state} for iccid, state in profiles],
    }


def main() -> int:
    m = load_module()
    now = 1_700_000_000

    # ---- 1. cache-only mode: nothing is read, presence is unknown ---------------
    reads: list[tuple] = []

    def reader(name, index):
        reads.append((name, index))
        return {"ses": []}

    cached = {
        "8900000000000000001": {"ses": [se("8900000000000000001", [("8944…01", "enabled")])],
                                "imei": "860000000000001", "ts": now - 60},
    }
    inventory = m.build_inventory(
        readers=["Reader A", "Reader B"], cached=cached, now=now, read_reader=reader
    )
    check("cache-only mode reads nothing", reads == [], f"{len(reads)} read(s) issued")
    check("the cached eUICC is listed", inventory["count"] == 1, str(inventory["count"]))
    check("it is not marked as refreshed", inventory["refreshed"] is False)

    entry = inventory["euiccs"][0]
    check(
        "a cached eUICC's presence is unknown, not asserted",
        entry["present"] is None,
        f"present={entry['present']!r} — the cache cannot tell us whether the card is still there",
    )
    check("the cached reader is not invented", entry["reader"] == "", repr(entry["reader"]))
    check("the profile count is carried through", entry["profiles"] == 1, str(entry["profiles"]))
    check("the enabled count is carried through", entry["enabled"] == 1, str(entry["enabled"]))
    check("the age is computed", entry["age_seconds"] == 60, str(entry["age_seconds"]))
    check("a fresh entry is not stale", entry["stale"] is False)

    # ---- 2. refresh: reads happen, sequentially --------------------------------
    reads.clear()

    def reader_with_cards(name, index):
        reads.append((name, index))
        if name == "Reader A":
            return {"ses": [se("EID-A", [("8944…01", "enabled"), ("8944…02", "disabled")])],
                    "imei": "111"}
        return {"ses": [se("EID-B", [("8944…03", "enabled")])], "imei": "222"}

    inventory = m.build_inventory(
        readers=["Reader A", "Reader B"], cached=cached, now=now, refresh=True,
        read_reader=reader_with_cards,
    )
    check("refresh reads every reader", reads == [("Reader A", 0), ("Reader B", 1)], str(reads))
    check("the reads are sequential and in order", [r[1] for r in reads] == [0, 1])
    check(
        "both read eUICCs are found, and the cached one is kept",
        inventory["count"] == 3,
        f"count={inventory['count']} — a refresh adds what it found; it does not silently "
        "delete a cached card that no reader reported, because a reader may have failed",
    )

    by_eid = {item["eid"]: item for item in inventory["euiccs"]}
    check("a read eUICC is marked present", by_eid["EID-A"]["present"] is True)
    check("a read eUICC carries its reader", by_eid["EID-A"]["reader"] == "Reader A")
    check("a read eUICC carries its IMEI", by_eid["EID-A"]["imei"] == "111")
    check("profiles are counted per card", by_eid["EID-A"]["profiles"] == 2, str(by_eid["EID-A"]["profiles"]))
    check("enabled profiles are counted", by_eid["EID-A"]["enabled"] == 1, str(by_eid["EID-A"]["enabled"]))
    check(
        "a freshly read card is not stale",
        by_eid["EID-A"]["stale"] is False and by_eid["EID-A"]["age_seconds"] == 0,
    )
    check(
        "the cached card that was not seen is reported as unseen",
        inventory["unseen"] == 1,
        f"unseen={inventory['unseen']} — it is in the cache but no reader reported it",
    )
    check(
        "an unseen cached card keeps presence unknown",
        by_eid["8900000000000000001"]["present"] is None,
        "a card that was not reported is not the same as a card that is gone",
    )

    # ---- 3. a plain USIM is not an error ---------------------------------------
    def reader_with_usim(name, index):
        return {"ses": [{"error": None, "profiles": []}]}  # no EID

    inventory = m.build_inventory(
        readers=["Reader A"], cached={}, now=now, refresh=True, read_reader=reader_with_usim
    )
    check(
        "a reader with no eUICC produces no entry",
        inventory["count"] == 0,
        str(inventory["count"]),
    )
    check(
        "a reader with no eUICC is not an error",
        inventory["errors"] == [],
        f"errors={inventory['errors']} — a plain USIM is the normal case",
    )

    # ---- 4. one reader failing does not lose the others ------------------------
    def flaky(name, index):
        if name == "Reader A":
            raise RuntimeError("SCARD_E_NO_SMARTCARD")
        return {"ses": [se("EID-B", [("8944…03", "enabled")])]}

    inventory = m.build_inventory(
        readers=["Reader A", "Reader B"], cached={}, now=now, refresh=True, read_reader=flaky
    )
    check("a failing reader does not lose the others", inventory["count"] == 1, str(inventory["count"]))
    check("the failure is named", len(inventory["errors"]) == 1, str(inventory["errors"]))
    check(
        "the failure names the reader and the error type, not a stack trace",
        "Reader A" in inventory["errors"][0] and "RuntimeError" in inventory["errors"][0],
        inventory["errors"][0],
    )

    # ---- 5. staleness -----------------------------------------------------------
    old = {"EID-OLD": {"ses": [se("EID-OLD", [("8944…09", "enabled")])], "ts": now - 7 * 3600}}
    inventory = m.build_inventory(readers=[], cached=old, now=now)
    entry = inventory["euiccs"][0]
    check("an old cache entry is flagged stale", entry["stale"] is True, str(entry))
    check(
        "a stale entry is still shown",
        entry["profiles"] == 1,
        "hiding it would leave the operator with less information, not more",
    )

    fresh = {"EID-NEW": {"ses": [se("EID-NEW", [])], "ts": now - 60}}
    inventory = m.build_inventory(readers=[], cached=fresh, now=now)
    check("a recent cache entry is not stale", inventory["euiccs"][0]["stale"] is False)

    # ---- 6. dual-SE cards -------------------------------------------------------
    dual = {"EID-D": {"ses": [se("EID-D", [("a", "enabled")]), se("EID-D", [("b", "disabled")])],
                      "ts": now}}
    inventory = m.build_inventory(readers=[], cached=dual, now=now)
    entry = inventory["euiccs"][0]
    check("a dual-SE card reports two secure elements", entry["ses"] == 2, str(entry["ses"]))
    check("profiles are summed across secure elements", entry["profiles"] == 2, str(entry["profiles"]))

    # ---- 7. a secure element error is surfaced but does not hide the card ------
    with_error = {"EID-E": {"ses": [se("EID-E", [("a", "enabled")], error="SE 2 读取失败")], "ts": now}}
    inventory = m.build_inventory(readers=[], cached=with_error, now=now)
    entry = inventory["euiccs"][0]
    check("a secure element error is surfaced", entry["errors"] == ["SE 2 读取失败"], str(entry["errors"]))
    check("the readable element is still counted", entry["profiles"] == 1, str(entry["profiles"]))

    # ---- 8. line mapping --------------------------------------------------------
    inventory = m.build_inventory(
        readers=[], cached=cached, now=now, line_for_eid=lambda eid: "line-1" if eid.endswith("1") else None
    )
    check("the line using an eUICC is reported", inventory["euiccs"][0]["line"] == "line-1")

    # ---- 9. ordering: cards found in a reader come first -----------------------
    inventory = m.build_inventory(
        readers=["Reader A"], cached=cached, now=now, refresh=True, read_reader=reader_with_cards
    )
    check(
        "eUICCs currently in a reader are listed before cache-only ones",
        inventory["euiccs"][0]["present"] is True,
        str([(item["eid"], item["present"]) for item in inventory["euiccs"]]),
    )

    # ---- 10. empty everything ---------------------------------------------------
    inventory = m.build_inventory(readers=[], cached={}, now=now)
    check("an empty host yields an empty inventory", inventory["count"] == 0 and inventory["euiccs"] == [])

    failed = [name for name, ok, _ in results if not ok]
    print()
    print(f"{len(results) - len(failed)}/{len(results)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
