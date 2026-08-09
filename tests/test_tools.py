"""Behaviour tests for tools.py, run against a throwaway sandbox."""
import json, os, sys, shutil, tempfile

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

print("\n== grep matches content, glob matches paths ==")
# "pattern" means two different things, and the sandbox check treated both as
# paths: `{"pattern": "def "}` was resolved against the working directory and
# refused for being outside the roots, so NO grep call had ever succeeded. It
# went unnoticed because nothing tested grep's success path - only that it was
# bounded.
os.makedirs(w("hay"), exist_ok=True)
open(w("hay/needle.py"), "w").write("import os\n\n\ndef main():\n    return 42\n")
open(w("hay/other.txt"), "w").write("nothing to see\n")

r = dispatch({"tool": "grep", "pattern": "def ", "path": w("hay")})
ck("grep with a plain regex works at all", r["ok"], r)
ck("...and finds the line", "def main" in str(r.get("matches", "")), r)
r = dispatch({"tool": "grep", "pattern": r"def\s+\w+\(", "path": w("hay")})
ck("a regex with metacharacters works too", r["ok"], r)
r = dispatch({"tool": "grep", "pattern": "os", "path": w("hay"), "glob": "*.py"})
ck("grep honours its file filter", r["ok"] and "other.txt" not in str(r.get("matches", "")), r)

# The regex is free; WHERE it searches is not.
r = dispatch({"tool": "grep", "pattern": "password", "path": "C:/Windows"})
ck("grep's path is still bounded",
   not r["ok"] and "outside allowed roots" in r["error"], r)
# glob's pattern IS a path, so it stays bounded.
r = dispatch({"tool": "glob", "pattern": "C:/Windows/**/*.ini"})
ck("glob's pattern is still bounded",
   not r["ok"] and "outside allowed roots" in r["error"], r)
r = dispatch({"tool": "glob", "pattern": w("hay/**/*.py")})
ck("glob inside the sandbox works", r["ok"] and len(r.get("files", [])) == 1, r)

print("\n== the sandbox still holds ==")
r = dispatch({"tool": "mkdir", "path": "C:/Windows/evil"})
ck("mkdir outside roots refused", not r["ok"] and "outside allowed roots" in r["error"], r)
dispatch({"tool": "write", "path": w("leak.txt"), "lines": ["secret"]})
r = dispatch({"tool": "move", "path": w("leak.txt"), "to": "C:/Windows/Temp/leak.txt"})
ck("move OUT of roots refused", not r["ok"] and "outside allowed roots" in r["error"], r)
ck("file stayed put", os.path.exists(w("leak.txt")))
r = dispatch({"tool": "delete", "path": tools.ALLOWED_ROOTS[0], "recursive": True})
ck("refuses to delete an allowed root", not r["ok"], r)

print("\n== git, without a shell to run it in ==")
import subprocess                                               # noqa: E402

REPO = os.path.join(WORK, "repo")
os.makedirs(REPO, exist_ok=True)


def git(*args):
    return subprocess.run(["git"] + list(args), cwd=REPO,
                          capture_output=True, text=True)

have_git = git("init", "-q").returncode == 0
if not have_git:
    print("  SKIP  git is not installed")
else:
    git("config", "user.email", "t@example.com")
    git("config", "user.name", "Test")
    open(os.path.join(REPO, "a.py"), "w").write("print(1)\n")
    git("add", "-A")
    git("commit", "-qm", "first")
    open(os.path.join(REPO, "a.py"), "w").write("print(2)\n")

    tools.set_roots([WORK])
    r = dispatch({"tool": "git_status", "cwd": REPO})
    ck("git_status works", r["ok"] and r.get("changed", 0) >= 1, r)
    ck("...and names the branch", bool(r.get("branch")), r)
    r = dispatch({"tool": "git_diff", "cwd": REPO})
    ck("git_diff works", r["ok"] and r.get("files") == 1, r)
    ck("...and carries the change", "print(2)" in r.get("diff", ""), r)
    r = dispatch({"tool": "git_status", "cwd": "C:/Windows"})
    ck("git is still bounded by the sandbox",
       not r["ok"] and "outside allowed roots" in r["error"], r)

    # A repository can name a program for git to run - diff.external, textconv,
    # fsmonitor, a pager. With no shell loaded that would be the way back to
    # arbitrary execution, so check it against a repository that tries.
    marker = os.path.join(REPO, "pwned.txt")
    payload = '"%s" -c "open(r\'%s\',\'w\').write(\'x\')"' % (sys.executable, marker)
    git("config", "diff.external", payload)

    # First prove the attack is real: plain git diff runs it.
    git("diff")
    attack_works = os.path.exists(marker)
    if os.path.exists(marker):
        os.remove(marker)
    ck("(the repository really can make git run a program)", attack_works)

    r = dispatch({"tool": "git_diff", "cwd": REPO})
    ck("git_diff refuses to run the repository's program",
       not os.path.exists(marker), r)
    ck("...and still returns the diff itself", r["ok"], r)
    git("config", "--unset", "diff.external")

print("\n== watch_file ==")
watched = w("watched.log")
# Binary, so the byte count is the same on a platform that would turn \n into
# \r\n on the way out.
open(watched, "wb").write(b"one\n")
r = dispatch({"tool": "watch_file", "path": watched})
ck("first sight registers the file", r["ok"] and r["status"] == "registered", r)
r = dispatch({"tool": "watch_file", "path": watched})
ck("unchanged when nothing happened", r["status"] == "unchanged", r)
open(watched, "ab").write(b"two\n")
r = dispatch({"tool": "watch_file", "path": watched})
ck("changed once it grows", r["status"] == "changed" and r.get("grew") == 4, r)
r = dispatch({"tool": "watch_file", "path": w("no_such.log")})
ck("a missing file is an error, not a silent 'unchanged'", not r["ok"], r)

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

print("\n== the default sandbox is the directory you start in ==")
# It used to be the whole home tree: every project, every key, every browser
# profile, for someone who typed one command to try the thing out.
here = os.getcwd().replace("\\", "/")
ck("the default is the working directory alone",
   tools.parse_roots(None) == [here], tools.parse_roots(None))
ck("...not the home tree",
   os.path.expanduser("~").replace("\\", "/").lower() not in
   [r.lower() for r in tools.parse_roots(None)])
tools.set_roots([here])
ck("within_roots agrees with the tools' own check",
   tools.within_roots(here) and not tools.within_roots("C:/Windows"))
ck("...and sees a subdirectory of a root as inside it",
   tools.within_roots(here + "/bridge"))
tools.set_roots([WORK])

print("\n== links cannot walk out of the sandbox ==")
# Not an exotic attack: `mklink /J` needs no privileges on Windows, and real
# project trees already carry links - pnpm fills node_modules with them, parts
# of AppData and OneDrive are reparse points. The allowlist compares strings,
# so a link inside a root is inside the sandbox by name and outside it in fact.
LINKS = os.path.join(WORK, "linktest")
IN_DIR = os.path.join(LINKS, "inside")
OUT_DIR = os.path.join(LINKS, "outside")
os.makedirs(IN_DIR, exist_ok=True)
os.makedirs(OUT_DIR, exist_ok=True)
open(os.path.join(OUT_DIR, "secret.txt"), "w").write("TOP SECRET\n")

def make_link(link, target):
    """A junction on Windows (no privileges needed), a symlink elsewhere."""
    try:
        if os.name == "nt":
            import subprocess
            subprocess.run(["cmd", "/c", "mklink", "/J", link, target],
                           capture_output=True, check=True)
        else:
            os.symlink(target, link)
        return os.path.exists(link)
    except Exception:
        return False

escape = os.path.join(IN_DIR, "escape")
if not make_link(escape, OUT_DIR):
    print("  SKIP  this platform would not create a link")
else:
    tools.set_roots([IN_DIR])
    esc = escape.replace("\\", "/")
    r = dispatch({"tool": "read", "path": esc + "/secret.txt"})
    ck("reading through a link out of the sandbox is refused",
       not r["ok"] and "outside allowed roots" in r["error"], r)
    r = dispatch({"tool": "write", "path": esc + "/planted.txt", "lines": ["owned"]})
    ck("writing through it is refused", not r["ok"], r)
    ck("...and nothing landed on the far side",
       not os.path.exists(os.path.join(OUT_DIR, "planted.txt")))
    r = dispatch({"tool": "list", "path": esc})
    ck("listing through it is refused", not r["ok"], r)
    dispatch({"tool": "write", "path": IN_DIR.replace("\\", "/") + "/carry.txt", "lines": ["x"]})
    r = dispatch({"tool": "move", "path": IN_DIR.replace("\\", "/") + "/carry.txt",
                  "to": esc + "/carry.txt"})
    ck("moving a file out through it is refused", not r["ok"], r)
    # The guard must bound by where a path RESOLVES, not punish links as such:
    # a link pointing back inside the sandbox is still inside it.
    inner = os.path.join(IN_DIR, "sub")
    os.makedirs(inner, exist_ok=True)
    if make_link(os.path.join(IN_DIR, "friendly"), inner):
        r = dispatch({"tool": "write",
                      "path": IN_DIR.replace("\\", "/") + "/friendly/ok.txt",
                      "lines": ["fine"]})
        ck("a link that stays inside the sandbox still works", r["ok"], r)
    # Deleting a root through an alias for it must be refused too.
    alias = os.path.join(LINKS, "alias")
    if make_link(alias, IN_DIR):
        tools.set_roots([IN_DIR, LINKS])
        r = dispatch({"tool": "delete", "path": alias.replace("\\", "/"), "recursive": True})
        ck("deleting an allowed root through an alias is refused",
           not r["ok"] and "allowed root" in r["error"], r)
        ck("...and the root is still there", os.path.isdir(IN_DIR))
    tools.set_roots([WORK])

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

print("\n== there is no shell unless it is asked for ==")
# The allowlist bounds the file tools; bash is the one tool no directory list
# can bound. Loading it by default made the sandbox a bound on twelve tools out
# of thirteen, so it is opt-in.
tools.set_roots([WORK])
ck("a plain run asks for no shell", agent.parse_args([second]).bash is False)
ck("--bash asks for one", agent.parse_args([second, "--bash"]).bash is True)
# 1.0 shipped --no-bash for this behaviour. It is the default now, so it has to
# keep parsing rather than break a shortcut somebody saved.
ck("--no-bash still parses, as a no-op", agent.parse_args([second, "--no-bash"]).bash is False)
ck("--bash with --no-bash is refused", rejects([second, "--bash", "--no-bash"]))

ck("disable_tools reports what it removed", tools.disable_tools(["bash"]) == ["bash"])
ck("...and removing it twice is not an error", tools.disable_tools(["bash"]) == [])
r = dispatch({"tool": "bash", "cmd": "echo should not run"})
ck("a bash call is now an unknown tool", not r["ok"] and "unknown tool" in r["error"], r)
ck("the error lists what is left, without bash",
   "bash" not in r.get("available", []) and len(r.get("available", [])) == len(tools.TOOLS), r)
ck("the file tools still work", dispatch({"tool": "list", "path": WORK})["ok"])

real_prompt = open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                                "prompts", "sys_prompt.txt"), encoding="utf-8").read()
nb = agent.build_prompt(real_prompt, [WORK], no_bash=True)
ck("the prompt stops advertising bash as an escape hatch",
   "Escape hatch. Runs through" not in nb and "NOT AVAILABLE in this session" in nb)
ck("the rule telling it to run its edits is replaced",
   "RUN it with bash" not in nb and "You cannot run anything" in nb)
ck("the worked example no longer ends on a shell command",
   "[3] bash  python" not in nb)
ck("the workspace says there is no shell", "There is no shell in this session" in nb)
ck("and drops the warning about bash being unbounded",
   "bash is NOT bounded" not in nb)
# With bash present none of that rewriting may happen.
yb = agent.build_prompt(real_prompt, [WORK], no_bash=False)
ck("with bash, the prompt is left alone",
   "Escape hatch. Runs through" in yb and "bash is NOT bounded" in yb)
ck("...and it is otherwise the same prompt",
   yb.count("── ") == nb.count("── "), f"{yb.count('── ')} vs {nb.count('── ')}")

# What the model is told and what dispatch will run are the same fact, read off
# the registry. A flag tracked alongside it could disagree with it.
ck("no_shell() follows the registry, not a flag", agent.no_shell() is True)
tools.TOOLS["bash"] = tools.t_bash
ck("...and follows it back", agent.no_shell() is False)

# The real entry point, not just the parser: a default run must leave no shell
# behind it. This is the finding the flag flip exists to close.
def tools_after(argv):
    tools.TOOLS["bash"] = tools.t_bash      # a fresh registry each time
    saved_argv, sys.argv = sys.argv, ["agent.py"]
    try:
        args = agent.parse_args(argv)
        if not args.bash:
            tools.disable_tools(["bash"])
    finally:
        sys.argv = saved_argv
    return set(tools.TOOLS)

ck("a plain run loads no shell", "bash" not in tools_after([]))
ck("naming directories still loads no shell", "bash" not in tools_after([second]))
ck("--all does not smuggle one back in", "bash" not in tools_after(["--all"]))
ck("--bash is the only way to get one", "bash" in tools_after(["--bash"]))
ck("only bash is affected either way",
   tools_after(["--bash"]) - tools_after([]) == {"bash"})

tools.TOOLS["bash"] = tools.t_bash          # the suite below expects all 13

print("\n== the agent answers the userscript and nothing else ==")
# Binding 127.0.0.1 does not keep out the web page you have open: a browser
# sends a page's fetch() to localhost quite happily, and these tools run shell
# commands. Every case below is a request a malicious page can actually make.
import contextlib, io, threading, urllib.error, urllib.request      # noqa: E402

tools.set_roots([WORK])
srv = agent.BridgeServer(("127.0.0.1", 0), agent.AgentHandler)
threading.Thread(target=srv.serve_forever, daemon=True).start()
BASE = "http://127.0.0.1:%d" % srv.server_address[1]

def hit(path="/", method="POST", headers=None, body=None):
    """Status code of one request, with the agent's console noise swallowed."""
    r = urllib.request.Request(BASE + path, data=body, method=method)
    for k, v in (headers or {}).items():
        r.add_header(k, v)
    with contextlib.redirect_stdout(io.StringIO()):
        try:
            with urllib.request.urlopen(r, timeout=10) as resp:
                return resp.status
        except urllib.error.HTTPError as e:
            return e.code

MARK = w("cross_origin_marker.txt")
EVIL = json.dumps({"calls": [{"tool": "write", "path": MARK, "lines": ["x"]}]}).encode()
JSON_H = {"Content-Type": "application/json"}
OK_H = dict(JSON_H, **{agent.AUTH_HEADER: "1"})

ck("a page's plain POST is refused", hit(body=EVIL, headers=JSON_H) == 403)
ck("...and refused BEFORE the call runs", not os.path.exists(MARK))
ck("a POST claiming an origin is refused",
   hit(body=EVIL, headers=dict(JSON_H, Origin="https://evil.example")) == 403)
# The header is what a page cannot send: it makes the request non-simple, so
# the browser preflights first. Answering that preflight would hand the page
# the very permission this depends on.
ck("the preflight that would allow the header is refused",
   hit(method="OPTIONS", headers={"Origin": "https://evil.example",
                                  "Access-Control-Request-Headers": agent.AUTH_HEADER}) == 403)
# DNS rebinding: an attacker domain answering 127.0.0.1 is same-origin with
# this agent by the browser's rules, so an Origin allowlist alone would not do.
ck("a request for someone else's host is refused",
   hit(body=EVIL, headers=dict(OK_H, Host="evil.example")) == 403)
ck("still nothing was written", not os.path.exists(MARK))

print("\n== pairing: the token nobody has to paste ==")
# The header stops web pages but cannot tell one LOCAL program from another.
# The agent mints a token per run and gives it away once, to whoever asks
# first; the userscript asks by itself. The race is a single moment at startup
# rather than a door open all run, and losing it is loud.
ck("the header alone is no longer enough", hit(body=EVIL, headers=OK_H) == 403)
ck("...and that call did not run either", not os.path.exists(MARK))

def paired_token():
    r = urllib.request.Request(BASE + "/pair", method="GET")
    for k, v in OK_H.items():
        r.add_header(k, v)
    with contextlib.redirect_stdout(io.StringIO()):
        with urllib.request.urlopen(r, timeout=10) as resp:
            return json.load(resp).get("token")

TOKEN = paired_token()
ck("pairing hands out a token", isinstance(TOKEN, str) and len(TOKEN) > 20)
ck("the token is this run's", TOKEN == agent.TOKEN)
FULL_H = dict(OK_H, **{agent.TOKEN_HEADER: TOKEN})

ck("a request carrying it is served", hit(body=EVIL, headers=FULL_H) == 200)
ck("...and it really did run", os.path.exists(MARK))
ck("a wrong token is refused",
   hit(body=EVIL, headers=dict(OK_H, **{agent.TOKEN_HEADER: "not-the-token"})) == 403)
# Whoever asks second does not get a second key to the same door.
ck("pairing twice is refused", hit("/pair", "GET", OK_H) == 409)
ck("GET /health needs the token too", hit("/health", "GET", OK_H) == 403)
ck("GET /health is served with it", hit("/health", "GET", FULL_H) == 200)
ck("GET /prompt is served with it", hit("/prompt", "GET", FULL_H) == 200)
# A page still cannot reach /pair: it is behind the same header and Host checks.
ck("a page cannot pair either", hit("/pair", "GET", JSON_H) == 403)
ck("...nor from a rebound host", hit("/pair", "GET", dict(OK_H, Host="evil.example")) == 403)

srv.shutdown()
tools.set_roots(saved)

print(f"\n{'FAILURES' if F else 'ALL PASS'}: {P} passed, {F} failed")
shutil.rmtree(WORK, ignore_errors=True)
sys.exit(1 if F else 0)
