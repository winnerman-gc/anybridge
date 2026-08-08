"""
Anybridge agent - the local half of the bridge.

Listens on localhost, runs typed tool calls posted by the userscript, and hands
back both the machine-readable results and the plain text pasted into the chat.
"""

import argparse
import json
import os
import sys
import time
from http.server import HTTPServer, BaseHTTPRequestHandler

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
from bridge.tools import TOOLS, dispatch, parse_roots, set_roots  # noqa: E402

VERSION = "1.0"

# Both are settled by the command line in main() before anything serves.
PORT = int(os.environ.get("BRIDGE_PORT", 3456))
ROOTS = parse_roots(os.environ.get("BRIDGE_ROOTS"))   # None means unrestricted

# Served to the userscript so a chat can be primed from the browser. The agent
# owns this file, so what the model is told it can do always matches the tool
# set this process actually has.
PROMPT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                           "prompts", "sys_prompt.txt")

STATS = {"batches": 0, "calls": 0, "failed": 0}
STARTED = time.time()


WORKSPACE_PLACEHOLDER = "{{WORKSPACE}}"


def parse_args(argv):
    ap = argparse.ArgumentParser(
        prog="agent.py",
        description="Local tool agent for any AI chat. Directories given here "
                    "are the sandbox: the file tools may act inside them and "
                    "nowhere else.",
        epilog="examples:\n"
               "  python agent.py                          home tree + C:/temp\n"
               "  python agent.py C:/work/api              only that project\n"
               "  python agent.py C:/work/api D:/notes     two directories\n"
               "  python agent.py --all                    no sandbox at all\n"
               "\n"
               "BRIDGE_ROOTS and BRIDGE_PORT still work; arguments win over both.",
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("dirs", nargs="*", metavar="DIR",
                    help="a directory the file tools may touch. Repeatable. "
                         "Defaults to your home tree plus C:/temp.")
    ap.add_argument("--all", "--unrestricted", dest="unrestricted",
                    action="store_true",
                    help="disable the sandbox: file tools may reach anything "
                         "this account can. bash is unbounded either way.")
    ap.add_argument("--port", type=int, default=PORT,
                    help=f"port to listen on (default {PORT})")
    args = ap.parse_args(argv)

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


def workspace_block(roots):
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
    body += ["",
             "bash is NOT bounded by this list. A shell command reaches "
             "whatever my account",
             "can, so treat shell commands with more care than file calls."]
    return "\n".join(body)


def build_prompt(text, roots):
    """Fill the served prompt's WORKSPACE section in from the live sandbox."""
    block = workspace_block(roots)
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


class AgentHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/health":
            self._respond({"status": "online", "name": "anybridge",
                           "version": VERSION, "tools": sorted(TOOLS)})
        elif self.path == "/prompt":
            # Read per request, not at import: editing the prompt then priming a
            # chat should not need the agent restarted.
            try:
                with open(PROMPT_PATH, encoding="utf-8") as fh:
                    text = fh.read()
            except OSError as e:
                ui.note(f"cannot read {PROMPT_PATH}: {e}", ui.C.RED)
                self._respond({"error": f"cannot read the system prompt: {e}"},
                              code=500)
                return
            text = build_prompt(text, ROOTS)
            ui.note(f"served the system prompt ({len(text)} chars)")
            self._respond({"prompt": text, "version": VERSION,
                           "roots": ROOTS if ROOTS is not None else "*"})
        else:
            self._respond({"error": "not found"}, code=404)

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
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
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(payload)

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

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
    # The command line wins over BRIDGE_ROOTS; with neither, ROOTS keeps the
    # default it was built with at import.
    if args.unrestricted:
        ROOTS = set_roots(None)
    elif args.dirs:
        ROOTS = set_roots(args.dirs)
    else:
        ROOTS = set_roots(ROOTS)

    ui.banner(VERSION, PORT, ROOTS or [], TOOLS, unrestricted=ROOTS is None)
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
