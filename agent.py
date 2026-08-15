"""
Anybridge agent - the local half of the bridge.

Listens on localhost, runs typed tool calls posted by the userscript, and hands
back both the machine-readable results and the plain text pasted into the chat.
"""

import argparse
import json
import os
import re
import secrets
import sys
import time
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import parse_qs

# Windows consoles default to cp1252, which cannot encode the box-drawing and
# status glyphs below - and it is worse when stdout is redirected to a file.
# This runs before bridge.console is imported so its capability check sees the
# stream it will actually be writing to.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

from bridge import console as ui                      # noqa: E402
from bridge.render import render_results              # noqa: E402
from bridge.tools import (MAX_IMAGE_BYTES, TOOLS, disable_tools,  # noqa: E402
                          dispatch, image_type, parse_roots, set_roots,
                          within_roots)

VERSION = "1.1"

# Both are settled by the command line in main() before anything serves. Whether
# a shell is loaded is NOT tracked separately: it is read off the tool registry
# by no_shell(), so the banner and the model's prompt cannot drift apart from
# what dispatch will actually run.
PORT = int(os.environ.get("BRIDGE_PORT", 3456))
ROOTS = parse_roots(os.environ.get("BRIDGE_ROOTS"))   # None means unrestricted


# Served to the userscript so a chat can be primed from the browser. The agent
# owns this file, so what the model is told it can do always matches the tool
# set this process actually has.
PROMPT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "prompts")
PROMPT_PATH = os.path.join(PROMPT_DIR, "sys_prompt.txt")


def prompt_path_for(site):
    """
    sys_prompt.<site>.txt when one exists, else the shared prompt.

    Sites differ in what they will accept, and not arbitrarily. Claude reads
    the shared prompt as an attempted jailbreak and says so - it asserts a
    capability the model cannot verify, and asks it to drop its usual judgment
    ("no caveats", "do not raise it again"), which is what a real injection
    looks like. Its own prompt describes the mechanism plainly, keeps its
    judgment intact, and invites it to test the loop rather than believe in it.
    """
    if site and re.fullmatch(r"[a-z0-9_-]{1,20}", str(site)):
        special = os.path.join(PROMPT_DIR, f"sys_prompt.{site}.txt")
        if os.path.isfile(special):
            return special
    return PROMPT_PATH

STATS = {"batches": 0, "calls": 0, "failed": 0}
STARTED = time.time()


WORKSPACE_PLACEHOLDER = "{{WORKSPACE}}"


def no_shell():
    """True when this run has no bash tool. Read from the registry, never
    from a flag: the prompt telling the model there is no shell and dispatch
    refusing to run one must be the same fact."""
    return "bash" not in TOOLS


def parse_args(argv):
    ap = argparse.ArgumentParser(
        prog="agent.py",
        description="Local tool agent for any AI chat. Directories given here "
                    "are the sandbox: the file tools may act inside them and "
                    "nowhere else.",
        epilog="examples:\n"
               "  python agent.py                          this directory, no shell\n"
               "  python agent.py C:/work/api              only that project\n"
               "  python agent.py C:/work/api D:/notes     two directories\n"
               "  python agent.py C:/work/api --bash       add the shell back\n"
               "  python agent.py --all --bash             no sandbox and a shell: everything\n"
               "\n"
               "There is no shell unless you ask for one. bash is the only tool the\n"
               "directory sandbox cannot bound, so it is off by default.\n"
               "\n"
               "BRIDGE_ROOTS and BRIDGE_PORT still work; arguments win over both.",
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("dirs", nargs="*", metavar="DIR",
                    help="a directory the file tools may touch. Repeatable. "
                         "Defaults to the directory you start the agent in.")
    ap.add_argument("--all", "--unrestricted", dest="unrestricted",
                    action="store_true",
                    help="disable the sandbox: file tools may reach anything "
                         "this account can.")
    ap.add_argument("--bash", dest="bash", action="store_true",
                    help="load the bash tool. It is the one tool no directory "
                         "list can bound - a shell command reaches whatever "
                         "this account can, wherever it lives. Off unless you "
                         "ask.")
    # --no-bash was how you got this behaviour in 1.0. It is the default now,
    # so accept it and do nothing rather than failing a command someone has in
    # a shortcut or a script.
    ap.add_argument("--no-bash", dest="no_bash", action="store_true",
                    help=argparse.SUPPRESS)
    ap.add_argument("--port", type=int, default=PORT,
                    help=f"port to listen on (default {PORT})")
    args = ap.parse_args(argv)

    if args.bash and args.no_bash:
        ap.error("--bash and --no-bash contradict each other")

    if args.unrestricted and args.dirs:
        # Silently letting one win would mean the banner and the model's prompt
        # disagree about what is reachable.
        ap.error("--all takes no directories: it already allows everything")

    # A mistyped directory would otherwise become a sandbox that allows nothing,
    # and every call would fail with a path error that names the typo as if it
    # were intended.
    missing = [d for d in args.dirs if not os.path.isdir(os.path.expanduser(d))]
    if missing:
        ap.error("not a directory: " + ", ".join(missing))
    return args


# Text the prompt carries about a shell that may not exist. Each is replaced
# rather than contradicted: a prompt that describes bash in three places and
# then says "except not really" invites the model to try it anyway and burn a
# turn on the error.
BASH_EDITS = [
    # The tool's own reference section, up to the next heading.
    (re.compile(r"── bash ─+\n.*?(?=\n── )", re.S),
     "── bash ────────────────────────────────────\n"
     "NOT AVAILABLE in this session. There is no shell: nothing here can run a\n"
     "program, a test, git, or a package manager. Do not emit a bash call.\n"),
    ("Use these rather than bash for file management. They are bounded by the\n"
     "directory allowlist; shell commands are not.",
     "These are the only way to touch anything, and they are bounded by the\n"
     "directory allowlist. There is no shell in this session."),
    ("5. After editing code, RUN it with bash to verify it actually works. A change\n"
     "   you have not executed is not finished.",
     "5. You cannot run anything - there is no shell here. Say what you changed and\n"
     "   what I should run to check it."),
    # The worked example of a rendered result ends on a bash call. Left alone it
    # is a demonstration that the tool works, sitting below the text saying it
    # does not.
    ("[3] bash  python C:/temp/app.py  ok  exit 0\nstdout:\nhi",
     "[3] list  C:/temp  ok  4 entries"),
]


def strip_bash(text):
    """Rewrite the served prompt for a session with no shell."""
    for find, repl in BASH_EDITS:
        text = find.sub(repl, text) if hasattr(find, "sub") else text.replace(find, repl)
    return text


def workspace_block(roots, no_bash=False):
    """The WORKSPACE section of the system prompt, describing the real sandbox."""
    if roots is None:
        body = ["The directory sandbox is DISABLED. File tools can reach "
                "anything my account can,",
                "so there is no allowlist to bounce a mistaken path. Be "
                "correspondingly careful",
                "with write, move and delete, and stay out of system "
                "directories unless I ask."]
    else:
        body = ["File tools may act inside these directories and nowhere else:",
                ""]
        body += [f"  {r}" for r in roots]
        body += ["",
                 "A path outside them fails with an error naming what is "
                 "allowed - that is the",
                 "guard working, not a bug. If a task genuinely needs another "
                 "directory, say so",
                 "and wait: I will restart the agent with that directory added."]
    if no_bash:
        body += ["",
                 "There is no shell in this session - the bash tool was not "
                 "loaded. Nothing here",
                 "can run a program, so the list above is the whole of what I "
                 "can reach."]
    else:
        body += ["",
                 "bash is NOT bounded by this list. A shell command reaches "
                 "whatever my account",
                 "can, so treat shell commands with more care than file calls."]
    return "\n".join(body)


def build_prompt(text, roots, no_bash=False):
    """Fill the served prompt's WORKSPACE section in from the live sandbox."""
    if no_bash:
        text = strip_bash(text)
    block = workspace_block(roots, no_bash)
    if WORKSPACE_PLACEHOLDER in text:
        return text.replace(WORKSPACE_PLACEHOLDER, block)
    # An edited prompt that dropped the placeholder still has to learn what it
    # may touch, so append rather than serve a prompt with no workspace at all.
    return text.rstrip("\n") + "\n\n" + block + "\n"


def normalize_calls(body):
    """
    Accept either the v3 tool format or the legacy v2 shell format:
      v3: {"calls": [{"tool": "read", ...}, ...]}
      v2: {"commands": ["dir C:/temp", ...]}   -> mapped to bash calls
    """
    calls = body.get("calls")
    if isinstance(calls, list) and calls:
        return calls
    commands = body.get("commands")
    if isinstance(commands, list):
        return [{"tool": "bash", "cmd": c} for c in commands]
    return []


# Only the userscript may talk to this agent. Binding 127.0.0.1 keeps
# other machines out, but it does NOT keep out the web page you happen to have
# open: a browser will happily send a page's fetch() to localhost, and the
# tools here run shell commands. Two things stand in the way, and both matter.
#
#   * A required custom header. A cross-origin request carrying one is not a
#     "simple request", so the browser must preflight it - and OPTIONS below
#     refuses every preflight. That leaves only requests that CANNOT set
#     headers (forms, no-cors fetch), which are refused for lacking it. There
#     is no third case a page can reach. The userscript is unaffected: it calls
#     through GM_xmlhttpRequest, which is privileged and never preflights.
#
#   * A Host check. Without it, an attacker domain whose DNS answers
#     127.0.0.1 is same-origin with this agent by the browser's rules, and
#     every origin-based defence evaporates. This is DNS rebinding, and it is
#     the reason an Origin allowlist alone would not be enough.
#
# Note what is deliberately absent: Access-Control-Allow-Origin. Advertising
# "*" told every site on the internet it could read the replies.
AUTH_HEADER = "X-Anybridge"
TOKEN_HEADER = "X-Anybridge-Token"
LOCAL_HOSTS = {"localhost", "127.0.0.1", "[::1]", "::1"}

# What the checks above cannot see is WHICH local program is calling. Any
# process running as you can send the header, so the tools were reachable by
# anything on the machine. A pasted secret would settle it, and a secret nobody
# pastes is the next best thing:
#
#   * The agent mints a token at startup and hands it out exactly ONCE, to the
#     first caller that asks (the userscript asks automatically, on its first
#     call and whenever its stored token stops working).
#   * Every later request must carry it.
#
# So the race is over a single moment at startup rather than a door left open
# for the whole run, and losing it is loud rather than silent: the bridge stops
# working and the console says another client took the pairing. Restart the
# agent and it re-pairs.
#
# Be clear about the limit. A program already running as you can read your
# files and start its own shell without this agent's help, so this is not a
# wall against local malware - nothing running as you can be. It stops casual
# and accidental access, and it makes deliberate access visible.
TOKEN = secrets.token_urlsafe(24)
PAIRED = False


class AgentHandler(BaseHTTPRequestHandler):
    def _pair(self):
        """Hand the token to the first caller that asks. Once."""
        global PAIRED
        if PAIRED:
            ui.note("a second client asked to pair and was refused - if the "
                    "bridge has stopped working, restart the agent", ui.C.RED)
            self._respond({"error": "already paired"}, code=409)
            return
        PAIRED = True
        ui.note("paired with a browser", ui.C.GREEN)
        self._respond({"token": TOKEN, "version": VERSION})

    def _image(self):
        """
        Serve the raw bytes of one image, for the userscript to attach.

        Every other tool result is text and travels inside the JSON reply. An
        image cannot: the browser needs a real File to hand the chat's upload
        code, and base64 inside the batch reply would be ~1.4x the file wrapped
        in a render capped at 30,000 characters.

        This adds no reach. The allowlist is applied here exactly as `dispatch`
        applies it, the request carries the same token as every other, and
        `read` could already return any text file inside the sandbox. What is
        new is only the encoding.
        """
        query = parse_qs(self.path.split("?", 1)[1]) if "?" in self.path else {}
        raw = (query.get("path") or [""])[0]
        if not raw:
            self._respond({"error": "no path given"}, code=400)
            return
        path = os.path.abspath(os.path.expanduser(raw.replace("\\", "/"))).replace("\\", "/")
        if not within_roots(path):
            ui.note(f"refused an image outside the sandbox: {path}", ui.C.RED)
            self._respond({"error": "path outside allowed roots"}, code=403)
            return
        try:
            size = os.path.getsize(path)
            with open(path, "rb") as fh:
                data = fh.read(MAX_IMAGE_BYTES + 1)
        except OSError as e:
            self._respond({"error": f"cannot read {path}: {e}"}, code=404)
            return
        # Checked again rather than trusted from the tool result: the browser
        # chooses what to ask for here, and a file can change between the two
        # calls.
        fmt, mime = image_type(data[:4096])
        if not fmt:
            ui.note(f"refused a non-image at {path}", ui.C.RED)
            self._respond({"error": "not an image file"}, code=415)
            return
        if size > MAX_IMAGE_BYTES:
            self._respond({"error": f"image is {size} bytes; too large"}, code=413)
            return
        ui.note(f"served {os.path.basename(path)} ({size} bytes, {fmt})")
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _authorised(self):
        host = (self.headers.get("Host") or "").rsplit(":", 1)[0].strip().lower()
        # A missing Host is HTTP/1.0 or a hand-rolled client, never a browser.
        if host and host not in LOCAL_HOSTS:
            ui.note(f"refused a request for host {host!r} - "
                    f"only localhost may reach this agent", ui.C.RED)
            return False
        if not self.headers.get(AUTH_HEADER):
            origin = self.headers.get("Origin") or "an unknown client"
            ui.note(f"refused a request from {origin} with no {AUTH_HEADER} "
                    f"header", ui.C.RED)
            return False
        # /pair is the one request that may arrive without the token, since it
        # is how a caller gets one. compare_digest keeps a wrong token from
        # being narrowed down a character at a time.
        if self.path != "/pair" and not secrets.compare_digest(
                self.headers.get(TOKEN_HEADER) or "", TOKEN):
            ui.note("refused a request with a missing or stale token", ui.C.RED)
            return False
        return True

    def do_GET(self):
        if not self._authorised():
            self._respond({"error": "forbidden"}, code=403)
            return
        if self.path == "/pair":
            self._pair()
        elif self.path == "/health":
            self._respond({"status": "online", "name": "anybridge",
                           "version": VERSION, "tools": sorted(TOOLS)})
        elif self.path.split("?")[0] == "/image":
            self._image()
        elif self.path.split("?")[0] == "/prompt":
            # Read per request, not at import: editing the prompt then priming a
            # chat should not need the agent restarted.
            site = ""
            if "?" in self.path:
                site = parse_qs(self.path.split("?", 1)[1]).get("site", [""])[0]
            path = prompt_path_for(site)
            try:
                with open(path, encoding="utf-8") as fh:
                    text = fh.read()
            except OSError as e:
                ui.note(f"cannot read {path}: {e}", ui.C.RED)
                self._respond({"error": f"cannot read the system prompt: {e}"},
                              code=500)
                return
            text = build_prompt(text, ROOTS, no_shell())
            ui.note(f"served {os.path.basename(path)} ({len(text)} chars)")
            # The roots are inside the prompt text where the model needs them.
            # Repeating them as a JSON field only made them easier to lift.
            self._respond({"prompt": text, "version": VERSION})
        else:
            self._respond({"error": "not found"}, code=404)

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        if not self._authorised():
            # Drain the body before answering. Replying while the client is
            # still sending resets the connection, so the caller sees a socket
            # error instead of the 403 telling it why it was refused.
            if length:
                self.rfile.read(length)
            self._respond({"error": "forbidden"}, code=403)
            return
        try:
            body = json.loads(self.rfile.read(length)) if length else {}
        except json.JSONDecodeError as e:
            ui.note(f"malformed JSON from the browser: {e}", ui.C.RED)
            self._respond({"results": [{"ok": False, "error": f"malformed JSON: {e}"}]})
            return

        calls = normalize_calls(body)
        if not calls:
            self._respond({"results": [{"ok": False,
                                        "error": 'no "calls" array in request'}]})
            return

        STATS["batches"] += 1
        ui.request_header(len(calls), STATS["batches"])
        for i, call in enumerate(calls, 1):
            ui.call_line(i, call)
        print()

        results = []
        batch_start = time.time()
        for i, call in enumerate(calls, 1):
            start = time.time()
            result = dispatch(call)
            results.append(result)
            ui.result_line(i, result, time.time() - start)

        STATS["calls"] += len(results)
        STATS["failed"] += sum(1 for r in results if not r.get("ok"))
        ui.batch_footer(results, time.time() - batch_start)

        # "results" stays the machine-readable contract; "render" is what the
        # userscript pastes into the chat for the model to read.
        self._respond({"results": results, "render": render_results(results)})

    def _respond(self, data, code=200):
        payload = json.dumps(data, indent=2).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(payload)

    def do_OPTIONS(self):
        # Answering a preflight is what would let a web page send the header
        # required above. Refusing every one of them is the point.
        self.send_response(403)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"error": "forbidden"}')

    def log_message(self, fmt, *args):
        pass       # the console output above replaces the default HTTP log


class BridgeServer(HTTPServer):
    # HTTPServer defaults this to True, which on Windows lets a SECOND agent
    # bind the same port silently while the FIRST keeps answering requests --
    # you then debug a stale version for an hour. Fail loudly instead.
    allow_reuse_address = False


def main(argv=None):
    global PORT, ROOTS
    args = parse_args(sys.argv[1:] if argv is None else argv)
    PORT = args.port
    # A shell is opt-in. The allowlist bounds the twelve file tools and cannot
    # bound this one, so loading it by default made the sandbox a bound on
    # twelve tools out of thirteen rather than a boundary.
    # A shell is opt-in. The allowlist bounds the twelve file tools and cannot
    # bound this one, so loading it by default made the sandbox a bound on
    # twelve tools out of thirteen rather than a boundary.
    if not args.bash:
        disable_tools(["bash"])
    # The command line wins over BRIDGE_ROOTS; with neither, ROOTS keeps the
    # default it was built with at import.
    if args.unrestricted:
        ROOTS = set_roots(None)
    elif args.dirs:
        ROOTS = set_roots(args.dirs)
    else:
        ROOTS = set_roots(ROOTS)

    ui.banner(VERSION, PORT, ROOTS or [], TOOLS, unrestricted=ROOTS is None,
              no_bash=no_shell())

    # Starting the agent from its own directory - the obvious thing to do after
    # cloning - puts agent.py, the tool layer and the userscript inside the
    # sandbox. A chat could then edit the guards that are bounding it, and the
    # next run would be bounded by whatever it wrote.
    if within_roots(os.path.dirname(os.path.abspath(__file__))):
        ui.note("this sandbox contains the bridge's own source, so a chat can "
                "edit the guards that bound it", ui.C.YELLOW)
        ui.note("name a project directory instead: python agent.py C:/path/to/project",
                ui.C.YELLOW)
        print()
    try:
        server = BridgeServer(("127.0.0.1", PORT), AgentHandler)
    except OSError as e:
        ui.note(f"cannot bind port {PORT}: {e}", ui.C.RED)
        ui.note("an older agent is probably still running - stop it, "
                "or set BRIDGE_PORT to another port.")
        print()
        return 1

    ui.ready()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        ui.farewell(STATS, STARTED)
    return 0


if __name__ == "__main__":
    sys.exit(main())
