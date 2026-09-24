#!/usr/bin/env python3
"""Behavioural checks for mdd-modem-driver-repair.py.

The script cannot be tested end to end without a DJI module attached, but the parts that
carry risk can be driven against a synthetic sysfs tree. What is worth proving:

  1. **The false-QMI-claim state is recognised.** This is the failure the whole script
     exists for: `qmi_wwan` holding the serial interfaces, which looks fine in `lsusb` and
     leaves the AT port dead. If `diagnose` does not flag it, the script silently does
     nothing and the user is back where they started.

  2. **The write ORDER is correct.** `option` cannot take an interface that `qmi_wwan`
     still holds, so every false claim has to be released *before* the option ID is
     registered — and the device-wide dynamic ID has to come off *before* that, or
     qmi_wwan re-grabs the interfaces as soon as they are released. Order is the feature.

  3. **An unexpected driver is a refusal, not a repair.** If some other driver owns an
     interface, this module has been customised already and guessing could break a working
     setup.

  4. **A correct layout produces no writes at all.** A repair script that "fixes" a healthy
     device is worse than useless.

Usage: python3 test-modem-repair.py
"""

from __future__ import annotations

import importlib.util
import io
import os
import shutil
import sys
import tempfile
from contextlib import redirect_stdout

HERE = os.path.dirname(os.path.abspath(__file__))

results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, ok, detail))
    print(f"{'PASS' if ok else 'FAIL'}  {name}{' — ' + detail if detail else ''}")


def load_module():
    spec = importlib.util.spec_from_file_location(
        "modem_repair", os.path.join(HERE, "mdd-modem-driver-repair.py")
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class FakeTree:
    """A synthetic sysfs tree.

    Device directories and every driver directory are real, so `_read`, `os.listdir` and
    the actual writes all run unmodified. Two things are faked, both of which are pure
    sysfs *reads* rather than logic:

      * `interface_driver` — in real sysfs `driver` is a symlink, and creating symlinks
        needs privileges this test should not require;
      * `interfaces_of` — interface directories are named `1-2:1.0`, and Windows forbids
        `:` in a path, so they cannot be materialised here.

    Everything under test — the diagnosis, the refusal rules, and the order of the sysfs
    writes — is the real code.
    """

    def __init__(self, root: str) -> None:
        self.root = root
        self.usb = os.path.join(root, "bus", "usb", "devices")
        self.usb_drivers = os.path.join(root, "bus", "usb", "drivers")
        self.serial_drivers = os.path.join(root, "bus", "usb-serial", "drivers")
        self.dev = os.path.join(root, "dev", "usb")
        self.drivers: dict[str, str] = {}
        self.ifaces: dict[str, list[int]] = {}
        self.writes: list[tuple[str, str]] = []

        for path in (self.usb, self.usb_drivers, self.serial_drivers, self.dev):
            os.makedirs(path, exist_ok=True)
        # Driver directories exist so the script's "is the driver loaded" checks pass.
        os.makedirs(os.path.join(self.usb_drivers, "qmi_wwan"), exist_ok=True)
        for node in ("bind", "unbind", "new_id", "remove_id"):
            self._write_raw(os.path.join(self.usb_drivers, "qmi_wwan", node), "")
        os.makedirs(os.path.join(self.serial_drivers, "option1"), exist_ok=True)
        self._write_raw(os.path.join(self.serial_drivers, "option1", "new_id"), "")

    def _write_raw(self, path: str, content: str) -> None:
        with io.open(path, "w", encoding="utf-8") as handle:
            handle.write(content)

    def add_device(self, name: str, vid: str, pid: str, bus: int, dev: int, interfaces: int) -> None:
        root = os.path.join(self.usb, name)
        os.makedirs(root, exist_ok=True)
        for key, value in (
            ("idVendor", vid),
            ("idProduct", pid),
            ("busnum", str(bus)),
            ("devnum", str(dev)),
        ):
            self._write_raw(os.path.join(root, key), value)
        self.ifaces[name] = list(range(interfaces))

    def bind(self, device: str, index: int, driver: str | None) -> None:
        iface = f"{device}:1.{index}"
        if driver is None:
            self.drivers.pop(iface, None)
        else:
            self.drivers[iface] = driver

    def patch(self, module) -> None:
        """Point the module at this tree and fake the one symlink-dependent function."""
        module.SYS_USB = self.usb
        module.SYS_USB_DRIVERS = self.usb_drivers
        module.SYS_USB_SERIAL_DRIVERS = self.serial_drivers
        module.DEV_USB = self.dev

        tree = self

        def fake_interface_driver(path: str) -> str | None:
            return tree.drivers.get(os.path.basename(path))

        def fake_interfaces_of(name: str):
            # The stored value is the sysfs *directory* basename (`option1`), and the real
            # `interfaces_of` normalises through `interface_driver`. Mirroring that here is
            # what makes this test able to catch a regression in `driver_family`.
            return [
                (
                    index,
                    f"{name}:1.{index}",
                    module.driver_family(tree.drivers.get(f"{name}:1.{index}")),
                )
                for index in sorted(tree.ifaces.get(name, []))
            ]

        module.interface_driver = fake_interface_driver
        module.interfaces_of = fake_interfaces_of

        # Record writes in order, and keep the fake driver bindings consistent with them so
        # a verification pass after repair sees the result.
        real_write = module._write

        def recording_write(path: str, value: str) -> None:
            tree.writes.append((path, value))
            driver_dir = os.path.basename(os.path.dirname(path))
            node = os.path.basename(path)
            if node == "bind":
                tree.drivers[value] = driver_dir
            elif node == "unbind":
                tree.drivers.pop(value, None)
            elif node == "new_id":
                # A dynamic ID registration makes the driver probe every unclaimed
                # vendor-specific interface — that is the behaviour under test.
                vid, _, pid = value.partition(" ")
                for device in tree.ifaces:
                    if tree._read_raw(os.path.join(tree.usb, device, "idVendor")) != vid:
                        continue
                    if tree._read_raw(os.path.join(tree.usb, device, "idProduct")) != pid:
                        continue
                    for index in tree.ifaces[device]:
                        iface = f"{device}:1.{index}"
                        if iface not in tree.drivers:
                            tree.drivers[iface] = driver_dir
            real_write(path, value)

        module._write = recording_write

    def _read_raw(self, path: str) -> str:
        try:
            with io.open(path, encoding="utf-8") as handle:
                return handle.read().strip()
        except OSError:
            return ""


def _is_write(path: str, *parts: str) -> bool:
    """True when `path` ends with the given path components, on any separator."""
    return path.replace("\\", "/").endswith("/".join(parts))


def main() -> int:
    module = load_module()
    layout = module.Layout("2ca3", "4006", [0, 1, 2, 3], 2, 4)

    # ---- 1. healthy device: no writes at all ------------------------------------
    with tempfile.TemporaryDirectory() as root:
        tree = FakeTree(root)
        tree.patch(module)
        tree.add_device("1-2", "2ca3", "4006", 1, 5, 5)
        # `option1` is what the sysfs directory is actually called; the driver is `option`.
        for index in (0, 1, 2, 3):
            tree.bind("1-2", index, "option1")
        tree.bind("1-2", 4, "qmi_wwan")

        report = module.Report()
        state = module.diagnose("1-2", layout, report)
        check("a healthy device needs no changes", state["needs"] == [], f"needs={state['needs']}")
        check("a healthy device reports no problems", report.problems == [], "; ".join(report.problems))

    # ---- 2. nothing bound: serial + qmi both needed ------------------------------
    with tempfile.TemporaryDirectory() as root:
        tree = FakeTree(root)
        tree.patch(module)
        tree.add_device("1-2", "2ca3", "4006", 1, 5, 5)

        report = module.Report()
        state = module.diagnose("1-2", layout, report)
        check(
            "an unbound device asks for both bindings",
            set(state["needs"]) == {"bind_serial", "bind_qmi"},
            f"needs={state['needs']}",
        )

    # ---- 3. the real failure: qmi_wwan holding the serial interfaces -------------
    with tempfile.TemporaryDirectory() as root:
        tree = FakeTree(root)
        tree.patch(module)
        tree.add_device("1-2", "2ca3", "4006", 1, 5, 5)
        # qmi_wwan grabbed 1-3 as well; the AT port on 2 is therefore dead.
        for index in (0, 1, 2, 3, 4):
            tree.bind("1-2", index, "qmi_wwan")

        report = module.Report()
        state = module.diagnose("1-2", layout, report)
        check(
            "a false QMI claim on the serial interfaces is detected",
            "detach_false_qmi" in state["needs"],
            f"needs={state['needs']}",
        )
        check(
            "the false claim is explained in words",
            any("AT port will not work" in text for text in report.problems),
            report.problems[0] if report.problems else "no problem reported",
        )

        # Repair, then check the order: the dynamic ID must be removed before option's
        # new_id is registered, and every false claim released first of all.
        report2 = module.Report()
        module.repair("1-2", layout, state, report2, use_dtr=False)

        order = [os.path.basename(p) for p, _ in tree.writes]
        first_unbind = order.index("unbind") if "unbind" in order else -1
        remove_idx = next(
            (i for i, (p, _) in enumerate(tree.writes) if _is_write(p, "qmi_wwan", "remove_id")),
            -1,
        )
        option_idx = next(
            (i for i, (p, _) in enumerate(tree.writes) if _is_write(p, "option1", "new_id")),
            -1,
        )
        check("the false claims are released", first_unbind >= 0, f"writes={order}")
        check(
            "the dynamic ID is removed before option probes",
            remove_idx >= 0 and option_idx > remove_idx,
            f"remove_id@{remove_idx} option new_id@{option_idx}",
        )
        check(
            "false claims are released before option probes",
            first_unbind >= 0 and option_idx > first_unbind,
            f"unbind@{first_unbind} option new_id@{option_idx}",
        )
        check(
            "the serial interfaces end up on option",
            all(
                module.driver_family(tree.drivers.get(f"1-2:1.{i}")) == "option"
                for i in (0, 1, 2, 3)
            ),
            str({i: tree.drivers.get(f"1-2:1.{i}") for i in range(5)}),
        )
        check(
            "the QMI interface ends up on qmi_wwan",
            module.driver_family(tree.drivers.get("1-2:1.4")) == "qmi_wwan",
            str(tree.drivers.get("1-2:1.4")),
        )

    # ---- 4. an unexpected driver is a refusal ------------------------------------
    with tempfile.TemporaryDirectory() as root:
        tree = FakeTree(root)
        tree.patch(module)
        tree.add_device("1-2", "2ca3", "4006", 1, 5, 5)
        tree.bind("1-2", 0, "cdc_acm")
        for index in (1, 2, 3):
            tree.bind("1-2", index, "option1")
        tree.bind("1-2", 4, "qmi_wwan")

        report = module.Report()
        state = module.diagnose("1-2", layout, report)
        check(
            "an unexpected driver causes a refusal",
            any("unexpected driver" in text for text in report.problems),
            report.problems[0] if report.problems else "no problem reported",
        )
        check(
            "a refusal schedules no changes",
            state["needs"] == [],
            f"needs={state['needs']}",
        )

    # ---- 5. a different USB composition is refused, not guessed at ---------------
    with tempfile.TemporaryDirectory() as root:
        tree = FakeTree(root)
        tree.patch(module)
        tree.add_device("1-2", "2ca3", "4006", 1, 5, 3)  # only 3 interfaces

        report = module.Report()
        state = module.diagnose("1-2", layout, report)
        check(
            "a missing interface is reported",
            any("expected interface(s) missing" in text for text in report.problems),
            report.problems[0] if report.problems else "no problem reported",
        )
        check("a missing interface schedules no changes", state["needs"] == [])

    # ---- 6. two devices: the CLI refuses rather than picking one -----------------
    with tempfile.TemporaryDirectory() as root:
        tree = FakeTree(root)
        tree.patch(module)
        tree.add_device("1-2", "2ca3", "4006", 1, 5, 5)
        tree.add_device("1-3", "2ca3", "4006", 1, 6, 5)

        found = module.find_devices("2ca3", "4006")
        check("two matching devices are both found", found == ["1-2", "1-3"], str(found))

        captured = io.StringIO()
        saved = sys.stderr
        sys.stderr = captured
        try:
            code = module.main([])
        finally:
            sys.stderr = saved
        check(
            "the CLI refuses to pick between two modules",
            code == 1 and "changes one module at a time" in captured.getvalue(),
            captured.getvalue().strip().splitlines()[0] if captured.getvalue() else "no message",
        )

    # ---- 7. preview mode writes nothing -----------------------------------------
    with tempfile.TemporaryDirectory() as root:
        tree = FakeTree(root)
        tree.patch(module)
        tree.add_device("1-2", "2ca3", "4006", 1, 5, 5)

        captured = io.StringIO()
        with redirect_stdout(captured):
            code = module.main([])  # no --apply
        check("preview mode exits 0", code == 0, f"exit={code}")
        check(
            "preview mode makes no changes",
            tree.writes == [],
            f"{len(tree.writes)} write(s) attempted",
        )
        check(
            "preview mode still prints the MDD config entry",
            '"vid": "2ca3"' in captured.getvalue() and '"at_interface": 2' in captured.getvalue(),
            "the driver layout and the modem_profiles entry are two halves of one thing",
        )

    failed = [name for name, ok, _ in results if not ok]
    print()
    print(f"{len(results) - len(failed)}/{len(results)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
