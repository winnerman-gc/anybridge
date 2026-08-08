"""Empirical audit of tools.py: what do the tools actually do to files?"""
import os, sys, shutil, tempfile
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

WORK = tempfile.mkdtemp(prefix="bridge_probe_")
os.environ["BRIDGE_ROOTS"] = WORK          # scope the probe to its own sandbox
from bridge import tools
from bridge.tools import dispatch

def raw(p):
    with open(p, 'rb') as f:
        return f.read()

def show(label, value):
    print(f"  {label:<46} {value}")

print(f"sandbox: {WORK}\n")

# ---------------------------------------------------------------- new files
print("== a brand-new file written by `write` ==")
p = (WORK + "/new.py").replace('\\', '/')
r = dispatch({"tool": "write", "path": p, "lines": ["import os", "print(os.getcwd())"]})
b = raw(p)
show("bytes on disk", b)
show("ends with a newline", b.endswith(b"\n") or b.endswith(b"\r\n"))
show("line ending used", "CRLF" if b"\r\n" in b else "LF")

# ---------------------------------------------------------------- round trip
print("\n== an existing LF file edited ==")
p2 = (WORK + "/unix.sh").replace('\\', '/')
open(p2, 'wb').write(b"#!/bin/sh\necho one\necho two\n")
dispatch({"tool": "read", "path": p2})
dispatch({"tool": "edit", "path": p2, "old": "echo one", "new": "echo ONE"})
b2 = raw(p2)
show("bytes after edit", b2)
show("line endings preserved as LF", b"\r\n" not in b2)
show("trailing newline preserved", b2.endswith(b"\n"))

print("\n== an existing CRLF file edited ==")
p3 = (WORK + "/win.txt").replace('\\', '/')
open(p3, 'wb').write(b"alpha\r\nbeta\r\ngamma\r\n")
dispatch({"tool": "read", "path": p3})
dispatch({"tool": "edit", "path": p3, "old": "beta", "new": "BETA"})
b3 = raw(p3)
show("bytes after edit", b3)
show("stayed CRLF", b3.count(b"\r\n") == 3)

# ---------------------------------------------------------------- guards
print("\n== read-before-write guard ==")
p4 = (WORK + "/guard.txt").replace('\\', '/')
open(p4, 'w').write("one\ntwo\nthree\n")
show("edit without reading", dispatch({"tool": "edit", "path": p4, "old": "two", "new": "2"}).get("error"))

print("\n== partial read then edit far outside the window ==")
p5 = (WORK + "/big.txt").replace('\\', '/')
open(p5, 'w').write("\n".join(f"line {i}" for i in range(1, 2001)) + "\n")
rd = dispatch({"tool": "read", "path": p5, "offset": 1, "limit": 5})
show("read showed", rd.get("shown") + f" of {rd.get('total_lines')}")
rl = dispatch({"tool": "replace_lines", "path": p5, "start": 1500, "end": 1500, "lines": ["CLOBBERED"]})
show("replace_lines at 1500 allowed", rl.get("ok"))

# ---------------------------------------------------------------- sandbox
print("\n== path allowlist ==")
outside = "C:/Windows/Temp/bridge_escape.txt"
show("write outside roots", dispatch({"tool": "write", "path": outside, "lines": ["x"]}).get("error"))
show("read via .. traversal",
     dispatch({"tool": "read", "path": WORK + "/../../Windows/win.ini"}).get("error"))
esc = dispatch({"tool": "bash", "cmd": f'echo escaped > "{outside}" && type "{outside}"'})
show("bash writing outside roots", f"ok={esc.get('ok')} stdout={esc.get('stdout')!r}")
if os.path.exists(outside):
    os.remove(outside)

# ---------------------------------------------------------------- binary/size
print("\n== awkward inputs ==")
pb = (WORK + "/blob.bin").replace('\\', '/')
open(pb, 'wb').write(bytes(range(256)) * 200)
rb = dispatch({"tool": "read", "path": pb})
show("read a binary file", f"ok={rb.get('ok')} lines={rb.get('total_lines')} "
                          f"content_chars={len(rb.get('content', ''))}")

pe = (WORK + "/empty.txt").replace('\\', '/')
open(pe, 'w').close()
re_ = dispatch({"tool": "read", "path": pe})
show("read an empty file", f"ok={re_.get('ok')} total_lines={re_.get('total_lines')}")

print("\n== missing capabilities ==")
for name in ("delete", "remove", "move", "rename", "copy", "mkdir", "multi_edit", "tree"):
    if name not in tools.TOOLS:
        print(f"  no `{name}` tool -> the model must use bash, which is NOT allowlisted")

shutil.rmtree(WORK, ignore_errors=True)
