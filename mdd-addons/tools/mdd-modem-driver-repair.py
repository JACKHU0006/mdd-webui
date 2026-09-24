#!/usr/bin/env python3
"""Bind a Quectel/DJI cellular module to the driver layout MDD expects.

WHY THIS EXISTS
---------------
MDD matches a modem by `(VID, PID)` against `hardware.modem_profiles` and then looks for a
tty on the interface named by `at_interface`. That config entry is necessary but not
sufficient: the module also has to be *bound to the right kernel drivers*, and a DJI
Cellular Dongle (`2ca3:4006`, a Quectel EG25-G in disguise) is not, out of the box, on
every host.

The DJI composition has five interfaces:

    interface 0,1,2,3  ->  option      (serial; interface 2 is the AT port)
    interface 4        ->  qmi_wwan    (QMI data)

Two things go wrong, and the second one is the interesting one:

  1. Nothing claims the vendor-specific interfaces, so there is no tty at all and MDD
     cannot talk to the module.

  2. `qmi_wwan`'s USB **dynamic ID is device-wide, not per-interface**. Once you have
     registered `2ca3 4006` to get interface 4 claimed, the driver also probes every other
     vendor-specific interface on that device. On this composition that turns interfaces
     1-3 into bogus `cdc-wdm` devices, and the AT port on interface 2 stops working —
     even though `lsusb` looks perfect and the tty may still exist.

     So the dynamic ID must be **removed again** after interface 4 is bound, and any false
     QMI claim must be detached before `option` is allowed to probe.

There is also a DTR step. The QDC507 acknowledges the `SET_CONTROL_LINE_STATE` control
transfer before its QMI firmware is ready, so the line state is toggled and then given a
second to settle. This is a real requirement, not a ritual, but it is skippable
(`--no-dtr`) so you can tell whether it is doing anything on your unit.

WHAT IT DELIBERATELY DOES NOT DO
--------------------------------
It does not write NV memory, change the USB VID/PID, or reflash anything. Every operation
is a sysfs write or a USB control transfer, both of which are undone by a replug. The
common advice on the internet is to rewrite the module's USB identity to Quectel's
`2c7c:0125` — that is a permanent NV write with a real chance of bricking the module, and
it is unnecessary: MDD's modem table is configuration, not hardcoded.

USAGE
-----
    # Preview only (default; makes no change)
    sudo python3 mdd-modem-driver-repair.py

    # Apply
    sudo python3 mdd-modem-driver-repair.py --apply

    # A different Quectel module, or a different interface layout
    sudo python3 mdd-modem-driver-repair.py --vid 2c7c --pid 0125 \
        --serial-interfaces 0-3 --at-interface 2 --qmi-interface 4

    # Skip the DTR toggle (to isolate whether it matters on your unit)
    sudo python3 mdd-modem-driver-repair.py --apply --no-dtr

    # Check the ioctl encoding without touching hardware
    python3 mdd-modem-driver-repair.py --self-test

Exit codes: 0 ok / nothing to do, 1 error, 2 usage error.
"""

from __future__ import annotations

import argparse
import errno
import json
import os
import struct
import sys
import time

# ---------------------------------------------------------------- USB control transfer

# `struct usbdevfs_ctrltransfer` as the kernel defines it:
#
#     __u8  bRequestType;   offset 0
#     __u8  bRequest;       offset 1
#     __u16 wValue;         offset 2
#     __u16 wIndex;         offset 4
#     __u16 wLength;        offset 6
#     __u32 timeout;        offset 8
#     void *data;           offset 16   (8-byte aligned on 64-bit)
#                                            total 24
#
# The compiler inserts 4 bytes of padding before `data`; getting that wrong makes the
# kernel read a garbage pointer, so the layout is spelled out explicitly rather than
# relying on `struct.pack`'s native alignment.
_CTRLTRANSFER_SIZE = 24
_CTRLTRANSFER_FMT = "=BBHHHI"  # 12 bytes, no padding
_CTRLTRANSFER_PAD = _CTRLTRANSFER_SIZE - struct.calcsize(_CTRLTRANSFER_FMT) - 8  # 4

USBDEVFS_CONTROL = (3 << 30) | (_CTRLTRANSFER_SIZE << 16) | (ord("U") << 8) | 0
"""`_IOWR('U', 0, struct usbdevfs_ctrltransfer)`."""

USB_CDC_REQ_SET_CONTROL_LINE_STATE = 0x22
USB_DIR_OUT_CLASS_INTERFACE = 0x21  # host -> device, class request, recipient = interface
USB_CDC_CTRL_DTR = 0x0001


def _control_transfer_buffer(interface: int, dtr: bool, timeout_ms: int) -> bytes:
    """Marshal a SET_CONTROL_LINE_STATE request. Pure function — see `--self-test`."""
    head = struct.pack(
        _CTRLTRANSFER_FMT,
        USB_DIR_OUT_CLASS_INTERFACE,
        USB_CDC_REQ_SET_CONTROL_LINE_STATE,
        USB_CDC_CTRL_DTR if dtr else 0,
        interface,
        0,  # wLength: this request carries no data stage
        timeout_ms,
    )
    # padding, then a NULL data pointer
    return head + b"\x00" * _CTRLTRANSFER_PAD + b"\x00" * 8


def set_control_line_state(fd: int, interface: int, dtr: bool, timeout_ms: int = 5000) -> None:
    # Imported here rather than at module scope so `--self-test` works on a workstation:
    # fcntl does not exist off Linux, and being unable to check the encoding without
    # hardware attached would be the wrong trade.
    import fcntl

    buf = bytearray(_control_transfer_buffer(interface, dtr, timeout_ms))
    fcntl.ioctl(fd, USBDEVFS_CONTROL, buf, True)


def assert_dtr(device_node: str, interface: int, settle_seconds: float = 1.0) -> None:
    """Clear then assert DTR on `interface`, then let the module settle.

    The clear-then-assert transition is what the module actually reacts to; asserting an
    already-asserted line is a no-op, which is why a plain "assert" is not enough.
    """
    fd = os.open(device_node, os.O_RDWR | os.O_CLOEXEC)
    try:
        set_control_line_state(fd, interface, False)
        time.sleep(0.05)
        set_control_line_state(fd, interface, True)
    finally:
        os.close(fd)
    # QDC507 acknowledges the control transfer before its QMI firmware is ready.
    time.sleep(settle_seconds)


# ------------------------------------------------------------------------- sysfs I/O

# The roots are overridable so this can be pointed at a captured tree (or a test fixture)
# without editing the script. Same convention as the other MDD host tools, e.g.
# `MDD_PVE_SYS_USB_ROOT` in tools/pve-bind-ec25-modems.sh.
SYS_USB = os.environ.get("MDD_SYS_USB_DEVICES", "/sys/bus/usb/devices")
SYS_USB_DRIVERS = os.environ.get("MDD_SYS_USB_DRIVERS", "/sys/bus/usb/drivers")
SYS_USB_SERIAL_DRIVERS = os.environ.get("MDD_SYS_USB_SERIAL_DRIVERS", "/sys/bus/usb-serial/drivers")
DEV_USB = os.environ.get("MDD_DEV_USB", "/dev/bus/usb")


def _read(path: str) -> str | None:
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as handle:
            return handle.read().strip()
    except OSError:
        return None


def _write(path: str, value: str) -> None:
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(value)


def driver_family(name: str | None) -> str | None:
    """Normalise a sysfs driver basename to the family name everyone means.

    This is not cosmetic. `option` is a *usb-serial* driver, and usb-serial registers one
    directory per instance — `option1`, `option2`, … — so an interface's `driver` symlink
    resolves to `option1` while the driver is universally called `option`. Comparing the
    raw basename against `"option"` therefore makes every correctly-bound module look
    unbound, and the script would "repair" a healthy device on every run and then report
    its own verification as failed.

    Only the `option` family is normalised. Stripping trailing digits in general would
    conflate genuinely different drivers.
    """
    if not name:
        return None
    if name.startswith("option") and name[len("option"):].isdigit():
        return "option"
    return name


def interface_driver(interface_path: str) -> str | None:
    """The driver family bound to a USB interface, or None when unbound.

    `/sys/bus/usb/devices/1-2:1.0/driver` is a symlink into the owning subsystem's driver
    directory. The basename is the only portable thing to read: the link target is a
    relative path whose depth differs per subsystem.
    """
    link = os.path.join(interface_path, "driver")
    if not os.path.islink(link):
        return None
    return driver_family(os.path.basename(os.readlink(link)))


def find_devices(vid: str, pid: str) -> list[str]:
    """sysfs names (e.g. `1-2`) of every USB device matching the IDs, in bus order."""
    found: list[str] = []
    if not os.path.isdir(SYS_USB):
        raise RuntimeError(
            f"{SYS_USB} is not present — this script needs Linux with sysfs. "
            "Run it on the gateway host, not on a workstation."
        )
    for name in os.listdir(SYS_USB):
        root = os.path.join(SYS_USB, name)
        if _read(os.path.join(root, "idVendor")) != vid:
            continue
        if _read(os.path.join(root, "idProduct")) != pid:
            continue
        # An interface directory has a `bInterfaceNumber`; skip those, we want the device.
        if os.path.exists(os.path.join(root, "bInterfaceNumber")):
            continue
        found.append(name)
    return sorted(found, key=_bus_port_key)


def _bus_port_key(name: str) -> tuple:
    """Sort `1-2.3` by (bus, port numbers) so ordering is stable and physical."""
    bus, _, port = name.partition("-")
    parts = tuple(int(p) for p in port.split(".") if p.isdigit())
    return (int(bus) if bus.isdigit() else 0, parts)


def device_node(name: str) -> str | None:
    bus = _read(os.path.join(SYS_USB, name, "busnum"))
    dev = _read(os.path.join(SYS_USB, name, "devnum"))
    if not (bus and dev and bus.isdigit() and dev.isdigit()):
        return None
    return os.path.join(DEV_USB, f"{int(bus):03d}", f"{int(dev):03d}")


def interfaces_of(name: str) -> list[tuple[int, str, str | None]]:
    """`[(index, sysfs_name, driver)]` for one device, ordered by interface number."""
    out: list[tuple[int, str, str | None]] = []
    prefix = f"{name}:"
    for entry in os.listdir(SYS_USB):
        if not entry.startswith(prefix) or ":1." not in entry:
            continue
        index = _read(os.path.join(SYS_USB, entry, "bInterfaceNumber"))
        if index is None:
            continue
        out.append((int(index, 16), entry, interface_driver(os.path.join(SYS_USB, entry))))
    return sorted(out)


def option_driver_dir() -> str | None:
    """The `option` usb-serial driver's sysfs directory.

    `option` registers as a *usb-serial* driver, so it lives under
    `/sys/bus/usb-serial/drivers/option1` — **not** under `/sys/bus/usb/drivers/option`.
    Looking in the wrong place is the single easiest way to write a version of this script
    that silently does nothing.
    """
    if not os.path.isdir(SYS_USB_SERIAL_DRIVERS):
        return None
    candidates = sorted(
        entry
        for entry in os.listdir(SYS_USB_SERIAL_DRIVERS)
        if entry == "option" or entry.startswith("option")
    )
    for entry in candidates:
        return os.path.join(SYS_USB_SERIAL_DRIVERS, entry)
    return None


def qmi_driver_dir() -> str:
    return os.path.join(SYS_USB_DRIVERS, "qmi_wwan")


# ------------------------------------------------------------------------- diagnosis

class Report:
    def __init__(self) -> None:
        self.lines: list[str] = []
        self.problems: list[str] = []
        self.actions: list[str] = []

    def line(self, text: str = "") -> None:
        self.lines.append(text)

    def problem(self, text: str) -> None:
        self.problems.append(text)

    def action(self, text: str) -> None:
        self.actions.append(text)

    def render(self) -> None:
        for text in self.lines:
            print(text)


def diagnose(device: str, layout: "Layout", report: Report) -> dict:
    """Describe the current state and decide what has to change."""
    state: dict = {"device": device, "interfaces": {}, "needs": []}

    report.line(f"device {device}  ({layout.vid}:{layout.pid})")
    node = device_node(device)
    report.line(f"  node       {node or 'unknown'}")
    report.line("  interfaces")

    serial_names = {f"{device}:1.{i}" for i in layout.serial_interfaces}
    qmi_name = f"{device}:1.{layout.qmi_interface}"

    present = {name for _, name, _ in interfaces_of(device)}
    for index, name, driver in interfaces_of(device):
        role = "AT" if index == layout.at_interface else ""
        if name == qmi_name:
            role = "QMI"
        elif name in serial_names:
            role = role or "serial"
        report.line(f"    {name:<14} {index:<3} {driver or '(unbound)':<10} {role}")
        state["interfaces"][index] = {"name": name, "driver": driver}

    missing = (serial_names | {qmi_name}) - present
    if missing:
        report.problem(
            f"expected interface(s) missing: {', '.join(sorted(missing))} — "
            "this is not the USB composition this script understands; nothing will be changed"
        )
        return state

    # Unexpected drivers are a refusal, not something to "fix": if some other driver owns
    # an interface, this module has already been customised and guessing is unsafe.
    for index, name, driver in interfaces_of(device):
        if name in serial_names and driver not in (None, "option", "qmi_wwan"):
            report.problem(
                f"{name} is bound to unexpected driver {driver!r} — refusing to replace it"
            )
            return state
        if name == qmi_name and driver not in (None, "option", "qmi_wwan"):
            report.problem(
                f"{name} is bound to unexpected driver {driver!r} — refusing to replace it"
            )
            return state

    # The device-wide dynamic ID is the subtle failure: it is registered whenever anything
    # has ever bound this device to qmi_wwan, and it makes qmi_wwan probe the serial
    # interfaces too.
    false_claims = [
        name
        for index, name, driver in interfaces_of(device)
        if name in serial_names and driver == "qmi_wwan"
    ]
    if false_claims:
        report.problem(
            "qmi_wwan is holding serial interface(s) "
            f"{', '.join(false_claims)} — the AT port will not work until they are released"
        )
        state["needs"].append("detach_false_qmi")

    serial_wrong = [
        name
        for index, name, driver in interfaces_of(device)
        if name in serial_names and driver != "option"
    ]
    if serial_wrong:
        state["needs"].append("bind_serial")
        if not false_claims:
            report.problem(
                f"serial interface(s) {', '.join(serial_wrong)} are not bound to `option`"
            )

    qmi_driver = state["interfaces"].get(layout.qmi_interface, {}).get("driver")
    if qmi_driver != "qmi_wwan":
        state["needs"].append("bind_qmi")
        report.problem(
            f"QMI interface {qmi_name} is not bound to `qmi_wwan`"
            f" (currently {qmi_driver or 'unbound'})"
        )

    if not state["needs"]:
        report.line("  -> layout already correct; nothing to do")
    return state


# --------------------------------------------------------------------------- repair

class Layout:
    def __init__(
        self,
        vid: str,
        pid: str,
        serial_interfaces: list[int],
        at_interface: int,
        qmi_interface: int,
    ) -> None:
        self.vid = vid
        self.pid = pid
        self.serial_interfaces = serial_interfaces
        self.at_interface = at_interface
        self.qmi_interface = qmi_interface


def _remove_dynamic_id(driver_dir: str, vid: str, pid: str, report: Report) -> None:
    """Best-effort removal of a device-wide dynamic ID.

    `remove_id` fails with ENOENT when the ID was never registered, which is the normal
    case — so a failure here is not an error, it is the answer to "was it registered?".
    """
    path = os.path.join(driver_dir, "remove_id")
    if not os.path.exists(path):
        return
    try:
        _write(path, f"{vid} {pid}")
        report.action(f"removed device-wide dynamic ID {vid} {pid} from {os.path.basename(driver_dir)}")
    except OSError as exc:
        if exc.errno not in (errno.ENOENT, errno.EINVAL):
            report.action(
                f"could not remove dynamic ID from {os.path.basename(driver_dir)}: {exc.strerror}"
            )


def _unbind(driver_dir: str, interface: str, report: Report) -> bool:
    try:
        _write(os.path.join(driver_dir, "unbind"), interface)
        report.action(f"unbound {interface} from {os.path.basename(driver_dir)}")
        return True
    except OSError as exc:
        report.action(f"could not unbind {interface}: {exc.strerror}")
        return False


def _bind(driver_dir: str, interface: str, report: Report) -> bool:
    try:
        _write(os.path.join(driver_dir, "bind"), interface)
        report.action(f"bound {interface} to {os.path.basename(driver_dir)}")
        return True
    except OSError as exc:
        report.action(f"could not bind {interface}: {exc.strerror}")
        return False


def repair(device: str, layout: Layout, state: dict, report: Report, use_dtr: bool) -> bool:
    """Establish the intended driver layout. Returns True on success."""
    serial_names = [f"{device}:1.{i}" for i in layout.serial_interfaces]
    qmi_name = f"{device}:1.{layout.qmi_interface}"
    needs = set(state["needs"])

    qmi_dir = qmi_driver_dir()
    option_dir = option_driver_dir()

    if "bind_serial" in needs and option_dir is None:
        report.problem(
            "the `option` usb-serial driver is not loaded — run `modprobe option` first"
        )
        return False
    if ("bind_qmi" in needs or "detach_false_qmi" in needs) and not os.path.isdir(qmi_dir):
        report.problem("the `qmi_wwan` driver is not loaded — run `modprobe qmi_wwan` first")
        return False

    # 1. Release every false QMI claim BEFORE option is allowed to probe. If qmi_wwan still
    #    holds these, option's dynamic-ID registration cannot take them.
    for name in serial_names:
        path = os.path.join(SYS_USB, name)
        if interface_driver(path) == "qmi_wwan":
            _unbind(qmi_dir, name, report)

    # 2. Remove the device-wide dynamic ID, so qmi_wwan stops probing serial interfaces.
    _remove_dynamic_id(qmi_dir, layout.vid, layout.pid, report)

    # 3. Hand the serial interfaces to `option` by registering the ID on the usb-serial
    #    driver, which makes it probe them.
    if "bind_serial" in needs or any(
        interface_driver(os.path.join(SYS_USB, n)) != "option" for n in serial_names
    ):
        new_id = os.path.join(option_dir, "new_id")
        try:
            _write(new_id, f"{layout.vid} {layout.pid}")
            report.action(f"registered {layout.vid} {layout.pid} on option")
        except OSError as exc:
            # EEXIST just means it was already registered.
            if exc.errno != errno.EEXIST:
                report.action(f"option new_id registration failed: {exc.strerror}")
        time.sleep(0.5)

    # 4. DTR: the module only reacts to a line-state *transition*.
    if use_dtr:
        node = device_node(device)
        if node and os.path.exists(node):
            try:
                assert_dtr(node, layout.qmi_interface)
                report.action(f"toggled DTR on {node} interface {layout.qmi_interface}")
            except OSError as exc:
                report.action(f"DTR toggle failed: {exc.strerror} (continuing)")
        else:
            report.action("device node unavailable; skipped the DTR toggle")

    # 5. Claim the QMI interface. The plain `bind` usually works once the dynamic ID is
    #    gone; if it does not, re-register the ID, bind, and remove it again — the ID is
    #    only needed for the duration of the bind.
    qmi_path = os.path.join(SYS_USB, qmi_name)
    if interface_driver(qmi_path) != "qmi_wwan":
        if not _bind(qmi_dir, qmi_name, report):
            try:
                _write(os.path.join(qmi_dir, "new_id"), f"{layout.vid} {layout.pid}")
                report.action(f"temporarily registered {layout.vid} {layout.pid} on qmi_wwan")
            except OSError as exc:
                if exc.errno != errno.EEXIST:
                    report.action(f"qmi_wwan new_id registration failed: {exc.strerror}")
            _bind(qmi_dir, qmi_name, report)
            _remove_dynamic_id(qmi_dir, layout.vid, layout.pid, report)
        time.sleep(0.5)

    return True


def verify(device: str, layout: Layout, report: Report) -> bool:
    """Re-read the state and report whether the layout is now what MDD needs."""
    ok = True
    report.line()
    report.line("verification")
    for index, name, driver in interfaces_of(device):
        if index in layout.serial_interfaces:
            good = driver == "option"
            ok = ok and good
            report.line(f"  {'ok  ' if good else 'FAIL'} {name:<14} option        {'(AT port)' if index == layout.at_interface else ''}")
        elif index == layout.qmi_interface:
            good = driver == "qmi_wwan"
            ok = ok and good
            report.line(f"  {'ok  ' if good else 'FAIL'} {name:<14} qmi_wwan")

    at_name = f"{device}:1.{layout.at_interface}"
    tty = None
    for entry in sorted(os.listdir(os.path.join(SYS_USB, at_name, "ttyUSB")) if os.path.isdir(os.path.join(SYS_USB, at_name, "ttyUSB")) else []):
        tty = entry
    if tty:
        report.line(f"  ok   AT port tty        /dev/{tty}")
    else:
        # Not a hard failure: the tty appears only after option probes, which can lag.
        report.line("  warn AT port tty        not present yet — replug the module or wait a moment")

    cdc = os.path.join(SYS_USB, f"{device}:1.{layout.qmi_interface}", "usbmisc")
    if os.path.isdir(cdc) and os.listdir(cdc):
        report.line(f"  ok   QMI control node   /dev/{os.listdir(cdc)[0]}")
    else:
        report.line("  warn QMI control node   no cdc-wdm yet")

    return ok


# ------------------------------------------------------------------------ MDD config

def modem_profile(layout: Layout) -> str:
    """The `hardware.modem_profiles` entry MDD needs, ready to paste into the settings UI.

    The driver layout and this entry are two halves of the same thing: the kernel gives the
    module a tty, and MDD needs to be told which `(VID, PID)` and which interface index to
    look on. Neither works without the other.
    """
    name = "DJI Cellular Dongle" if (layout.vid, layout.pid) == ("2ca3", "4006") else f"Quectel {layout.vid}:{layout.pid}"
    return json.dumps(
        {
            "name": name,
            "vid": layout.vid,
            "pid": layout.pid,
            "at_interface": layout.at_interface,
        },
        ensure_ascii=False,
        indent=2,
    )


# -------------------------------------------------------------------------- self-test

def self_test() -> int:
    """Verify the ioctl encoding without touching hardware.

    The struct layout is the one thing here that cannot be caught by reading the code: an
    off-by-four in the padding makes the kernel dereference a garbage pointer, and the
    symptom is an EFAULT far from the cause.
    """
    failures: list[str] = []

    def check(label: str, actual, expected) -> None:
        if actual == expected:
            print(f"ok    {label}")
        else:
            failures.append(label)
            print(f"FAIL  {label}: got {actual!r}, expected {expected!r}")

    check("USBDEVFS_CONTROL ioctl number", hex(USBDEVFS_CONTROL), hex(0xC0185500))
    check("control transfer size", _CTRLTRANSFER_SIZE, 24)
    check("padding before the data pointer", _CTRLTRANSFER_PAD, 4)

    buf = _control_transfer_buffer(interface=4, dtr=True, timeout_ms=5000)
    check("marshalled size", len(buf), 24)
    check("bRequestType (out|class|interface)", buf[0], 0x21)
    check("bRequest (SET_CONTROL_LINE_STATE)", buf[1], 0x22)
    check("wValue (DTR asserted)", struct.unpack_from("<H", buf, 2)[0], 1)
    check("wIndex (interface 4)", struct.unpack_from("<H", buf, 4)[0], 4)
    check("wLength (no data stage)", struct.unpack_from("<H", buf, 6)[0], 0)
    check("timeout (ms)", struct.unpack_from("<I", buf, 8)[0], 5000)
    check("data pointer is NULL", buf[16:24], b"\x00" * 8)

    cleared = _control_transfer_buffer(interface=0, dtr=False, timeout_ms=1000)
    check("wValue when DTR is cleared", struct.unpack_from("<H", cleared, 2)[0], 0)

    print()
    if failures:
        print(f"{len(failures)} check(s) failed")
        return 1
    print("all checks passed")
    return 0


# ------------------------------------------------------------------------------- main

def parse_interfaces(spec: str) -> list[int]:
    """`0-3` -> [0,1,2,3]; also accepts `0,1,2,3`."""
    out: list[int] = []
    for chunk in spec.split(","):
        chunk = chunk.strip()
        if not chunk:
            continue
        if "-" in chunk:
            start, _, end = chunk.partition("-")
            try:
                out.extend(range(int(start), int(end) + 1))
            except ValueError:
                raise argparse.ArgumentTypeError(f"bad interface range: {chunk!r}") from None
        else:
            try:
                out.append(int(chunk))
            except ValueError:
                raise argparse.ArgumentTypeError(f"bad interface number: {chunk!r}") from None
    if not out:
        raise argparse.ArgumentTypeError("no interfaces given")
    return sorted(set(out))


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        description="Bind a Quectel/DJI module to the driver layout MDD expects.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--apply", action="store_true", help="make the changes (default: preview)")
    parser.add_argument("--vid", default="2ca3", help="USB vendor ID (default: 2ca3, DJI)")
    parser.add_argument("--pid", default="4006", help="USB product ID (default: 4006, DJI)")
    parser.add_argument(
        "--serial-interfaces",
        default="0-3",
        type=parse_interfaces,
        help="interfaces that belong to `option` (default: 0-3)",
    )
    parser.add_argument("--at-interface", type=int, default=2, help="interface carrying the AT port (default: 2)")
    parser.add_argument("--qmi-interface", type=int, default=4, help="interface for qmi_wwan (default: 4)")
    parser.add_argument("--no-dtr", action="store_true", help="skip the DTR line-state toggle")
    parser.add_argument("--self-test", action="store_true", help="check the ioctl encoding and exit")
    args = parser.parse_args(argv)

    if args.self_test:
        return self_test()

    vid, pid = args.vid.lower(), args.pid.lower()
    layout = Layout(vid, pid, args.serial_interfaces, args.at_interface, args.qmi_interface)

    try:
        devices = find_devices(vid, pid)
    except RuntimeError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    if not devices:
        print(f"No USB device {vid}:{pid} found.", file=sys.stderr)
        print("  * Is the module plugged in?", file=sys.stderr)
        print("  * `lsusb` should list it; if it does not, this is a USB/passthrough problem,", file=sys.stderr)
        print("    not a driver problem (see tools/pve-bind-ec25-modems.sh for PVE).", file=sys.stderr)
        return 1

    if len(devices) > 1:
        print(
            f"ERROR: {len(devices)} devices match {vid}:{pid} ({', '.join(devices)}). "
            "This script changes one module at a time; unplug the others or run it on a host "
            "with a single module attached.",
            file=sys.stderr,
        )
        return 1

    if args.apply and os.geteuid() != 0:
        print("ERROR: --apply needs root (sysfs writes and /dev/bus/usb access).", file=sys.stderr)
        return 1

    device = devices[0]
    report = Report()

    state = diagnose(device, layout, report)
    report.render()

    if report.problems:
        print()
        print("problems")
        for text in report.problems:
            print(f"  * {text}")

    if not state["needs"]:
        print()
        print("Nothing to change.")
        print()
        print("MDD still needs this entry in 设置 -> 硬件 (hardware.modem_profiles):")
        print(modem_profile(layout))
        return 0

    print()
    if not args.apply:
        print("Preview only. Re-run with --apply to make these changes.")
        print()
        print("MDD also needs this entry in 设置 -> 硬件 (hardware.modem_profiles):")
        print(modem_profile(layout))
        return 0

    print("applying")
    if not repair(device, layout, state, report, use_dtr=not args.no_dtr):
        for text in report.actions:
            print(f"  * {text}")
        print()
        print("ERROR: the layout could not be established; see the messages above.", file=sys.stderr)
        return 1

    for text in report.actions:
        print(f"  * {text}")

    ok = verify(device, layout, report)
    report.render()

    print()
    print("Add this to 设置 -> 硬件 (hardware.modem_profiles) if it is not there already:")
    print(modem_profile(layout))
    print()
    if ok:
        print("Done. The driver layout matches what MDD expects.")
        print("Changes are not persistent across a replug — re-run with --apply after replugging.")
    else:
        print("Finished, but verification did not fully pass. Replug the module and re-run,")
        print("then check `sudo ./install.sh logs` if the line still does not come up.")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
