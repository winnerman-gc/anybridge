"""Behaviour tests for tools.py, run against a throwaway sandbox."""
import os, sys, shutil, tempfile

WORK = tempfile.mkdtemp(prefix="bridge_test_")
os.environ["BRIDGE_ROOTS"] = WORK
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from bridge import tools
from bridge.tools import dispatch

P, F = 0, 0
def ck(name, cond, extra=""):
    global P, F
    print(("  PASS  " if cond else "  FAIL  ") + name)
    if not cond and extra:
        print("        " + str(extra))
    P += cond; F += not cond

def w(rel):
    return (WORK + "/" + rel).replace("\\", "/")

def raw(p):
    with open(p, "rb") as f:
        return f.read()

print("== files created by write ==")
p = w("new.py")
dispatch({"tool": "write", "path": p, "lines": ["import os", "print(1)"]})
ck("ends with a newline", raw(p).endswith(b"\n"), raw(p))
ck("defaults to LF, not CRLF", b"\r\n" not in raw(p), raw(p))
ck("content is exactly the lines given", raw(p) == b"import os\nprint(1)\n", raw(p))
dispatch({"tool": "write", "path": w("crlf.txt"), "lines": ["a", "b"], "eol": "crlf"})
ck('eol:"crlf" honoured when asked', raw(w("crlf.txt")) == b"a\r\nb\r\n", raw(w("crlf.txt")))

print("\n== existing files keep their own line endings ==")
open(w("unix.sh"), "wb").write(b"#!/bin/sh\necho one\necho two\n")
dispatch({"tool": "read", "path": w("unix.sh")})
dispatch({"tool": "edit", "path": w("unix.sh"), "old": "echo one", "new": "echo ONE"})
ck("LF file stays LF", raw(w("unix.sh")) == b"#!/bin/sh\necho ONE\necho two\n", raw(w("unix.sh")))
open(w("win.txt"), "wb").write(b"alpha\r\nbeta\r\n")
dispatch({"tool": "read", "path": w("win.txt")})
dispatch({"tool": "edit", "path": w("win.txt"), "old": "beta", "new": "BETA"})
ck("CRLF file stays CRLF", raw(w("win.txt")) == b"alpha\r\nBETA\r\n", raw(w("win.txt")))

print("\n== counting ==")
open(w("empty.txt"), "w").close()
ck("empty file is 0 lines", dispatch({"tool": "read", "path": w("empty.txt")})["total_lines"] == 0)
open(w("three.txt"), "wb").write(b"a\nb\nc\n")
ck("3-line file is 3 lines", dispatch({"tool": "read", "path": w("three.txt")})["total_lines"] == 3,
   dispatch({"tool": "read", "path": w("three.txt")})["total_lines"])

print("\n== reading what should not be read ==")
open(w("blob.bin"), "wb").write(bytes(range(256)) * 100)
r = dispatch({"tool": "read", "path": w("blob.bin")})
ck("binary file refused", not r["ok"] and "binary" in r["error"], r)
big = w("huge.txt")
with open(big, "wb") as f:
    f.write(b"x" * (tools.MAX_READ_BYTES + 10))
r = dispatch({"tool": "read", "path": big})
ck("oversized file refused", not r["ok"] and "too large" in r["error"], r)
os.remove(big)

print("\n== partial read does not unlock the whole file ==")
lines = [f"line {i}" for i in range(1, 201)]
open(w("big.txt"), "w").write("\n".join(lines) + "\n")
dispatch({"tool": "read", "path": w("big.txt"), "offset": 1, "limit": 5})
r = dispatch({"tool": "replace_lines", "path": w("big.txt"), "start": 150, "end": 150,
              "lines": ["CLOBBERED"]})
ck("replace_lines outside the read window refused", not r["ok"], r)
ck("file untouched", "CLOBBERED" not in open(w("big.txt")).read())
r = dispatch({"tool": "replace_lines", "path": w("big.txt"), "start": 2, "end": 3,
              "lines": ["two", "three"]})
ck("replace_lines inside the read window allowed", r["ok"], r)

print("\n== overwriting a file you have only partly seen ==")
dispatch({"tool": "read", "path": w("big.txt"), "offset": 1, "limit": 5})
r = dispatch({"tool": "write", "path": w("big.txt"), "lines": ["gone"]})
ck("write refused after a partial read", not r["ok"] and "not read all" in r["error"], r)
dispatch({"tool": "read", "path": w("big.txt"), "offset": 1, "limit": 1000})
r = dispatch({"tool": "write", "path": w("big.txt"), "lines": ["gone"]})
ck("write allowed after a full read", r["ok"], r)

print("\n== line numbers go stale after an edit ==")
open(w("shift.txt"), "w").write("a\nb\nc\n")
dispatch({"tool": "read", "path": w("shift.txt")})
dispatch({"tool": "insert_lines", "path": w("shift.txt"), "after": 0, "lines": ["zero"]})
r = dispatch({"tool": "replace_lines", "path": w("shift.txt"), "start": 1, "end": 1, "lines": ["X"]})
ck("replace_lines refused until re-read", not r["ok"], r)

print("\n== new tools ==")
ck("mkdir", dispatch({"tool": "mkdir", "path": w("sub/deep")})["ok"])
dispatch({"tool": "write", "path": w("sub/deep/a.txt"), "lines": ["hello"]})
ck("copy", dispatch({"tool": "copy", "path": w("sub/deep/a.txt"), "to": w("sub/b.txt")})["ok"])
ck("copy landed", os.path.exists(w("sub/b.txt")))
ck("move", dispatch({"tool": "move", "path": w("sub/b.txt"), "to": w("sub/c.txt")})["ok"])
ck("move removed the source", not os.path.exists(w("sub/b.txt")) and os.path.exists(w("sub/c.txt")))
r = dispatch({"tool": "copy", "path": w("sub/deep/a.txt"), "to": w("sub/c.txt")})
ck("copy refuses to clobber", not r["ok"] and "exists" in r["error"], r)
# A file that appeared on disk without the model ever seeing its content.
open(w("sub/stranger.txt"), "w").write("who wrote this\n")
r = dispatch({"tool": "delete", "path": w("sub/stranger.txt")})
ck("delete refuses a file never seen", not r["ok"] and "must read" in r["error"], r)
dispatch({"tool": "read", "path": w("sub/stranger.txt")})
ck("delete works once read", dispatch({"tool": "delete", "path": w("sub/stranger.txt")})["ok"])
# c.txt is a move of a copy of a file the model wrote, so its content is known
# and re-reading it would prove nothing.
ck("delete works on a copy of a known file", dispatch({"tool": "delete", "path": w("sub/c.txt")})["ok"])
r = dispatch({"tool": "delete", "path": w("sub")})
ck("delete refuses a non-empty dir", not r["ok"] and "not empty" in r["error"], r)
ck("delete recursive works", dispatch({"tool": "delete", "path": w("sub"), "recursive": True})["ok"])
ck("sub is gone", not os.path.exists(w("sub")))

print("\n== the sandbox still holds ==")
r = dispatch({"tool": "mkdir", "path": "C:/Windows/evil"})
ck("mkdir outside roots refused", not r["ok"] and "outside allowed roots" in r["error"], r)
dispatch({"tool": "write", "path": w("leak.txt"), "lines": ["secret"]})
r = dispatch({"tool": "move", "path": w("leak.txt"), "to": "C:/Windows/Temp/leak.txt"})
ck("move OUT of roots refused", not r["ok"] and "outside allowed roots" in r["error"], r)
ck("file stayed put", os.path.exists(w("leak.txt")))
r = dispatch({"tool": "delete", "path": tools.ALLOWED_ROOTS[0], "recursive": True})
ck("refuses to delete an allowed root", not r["ok"], r)

print("\n== the sandbox given on the command line ==")
# agent.py hands its DIR arguments to set_roots, so what it accepts on the
# command line and what the tools enforce have to be the same thing.
import agent                                                    # noqa: E402

second = os.path.join(WORK, "second")
os.makedirs(second, exist_ok=True)
saved = tools.ALLOWED_ROOTS

tools.set_roots([second])
ck("set_roots narrows the allowlist to what was given",
   tools.ALLOWED_ROOTS == [second.replace("\\", "/")], tools.ALLOWED_ROOTS)
r = dispatch({"tool": "list", "path": WORK})
ck("a path outside the new roots is refused",
   not r["ok"] and "outside allowed roots" in r["error"], r)
r = dispatch({"tool": "list", "path": second})
ck("a path inside the new roots is allowed", r["ok"], r)

tools.set_roots(None)
ck("set_roots(None) disables the sandbox", tools.ALLOWED_ROOTS is None)
ck("unrestricted really does reach outside",
   dispatch({"tool": "list", "path": WORK})["ok"])

ck('parse_roots("*") is unrestricted', tools.parse_roots("*") is None)
ck("parse_roots splits on the path separator",
   tools.parse_roots(second + os.pathsep + WORK)
   == [second.replace("\\", "/"), WORK.replace("\\", "/")])
ck("parse_roots falls back to the defaults when empty",
   tools.parse_roots("") == tools.parse_roots(None) != [])

print("\n== the sandbox as the model is told about it ==")
filled = agent.build_prompt("before\n{{WORKSPACE}}\nafter", [second])
ck("the served prompt names every allowed directory", second in filled, filled)
ck("the placeholder is gone", "{{WORKSPACE}}" not in filled)
ck("the rest of the prompt survives", filled.startswith("before") and filled.rstrip().endswith("after"))
ck("a prompt with no placeholder still gets the section",
   second in agent.build_prompt("no placeholder here", [second]))
unres = agent.build_prompt("{{WORKSPACE}}", None)
ck("unrestricted mode says so rather than listing nothing",
   "DISABLED" in unres, unres)
ck("either way the model is told bash is not bounded",
   "bash is NOT bounded" in unres and "bash is NOT bounded" in filled)

# The real prompt has to carry the placeholder, or priming a chat would
# describe a sandbox nobody set.
real = open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                         "prompts", "sys_prompt.txt"), encoding="utf-8").read()
ck("prompts/sys_prompt.txt still has the WORKSPACE placeholder",
   "{{WORKSPACE}}" in real)

# --all plus directories is contradictory; agent.py must reject it, not pick one.
# argparse writes its usage to stderr on the way out; swallow it, or the runner
# reports that line as this suite's result.
def rejects(argv):
    import contextlib, io
    try:
        with contextlib.redirect_stderr(io.StringIO()):
            agent.parse_args(argv)
        return False
    except SystemExit:
        return True

ck("--all with a directory is rejected", rejects(["--all", second]))
ck("a directory that does not exist is rejected",
   rejects([os.path.join(WORK, "does_not_exist")]))
ck("plain arguments become the sandbox", agent.parse_args([second]).dirs == [second])

tools.set_roots(saved)

print(f"\n{'FAILURES' if F else 'ALL PASS'}: {P} passed, {F} failed")
shutil.rmtree(WORK, ignore_errors=True)
sys.exit(1 if F else 0)
