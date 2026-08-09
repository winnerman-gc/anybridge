"""
Console presentation for the Anybridge agent.

Kept apart from agent.py so the server logic stays readable, and so the whole
interface degrades in one place: colour and box-drawing are capabilities to be
detected, never assumed. A terminal that cannot render them still gets a usable
log rather than a screenful of question marks.
"""

import os
import shutil
import sys
import time

# ---------------------------------------------------------------- capabilities

def _supports_colour(stream):
    # https://no-color.org - honoured by convention, and the polite default when
    # output is being piped into a file or another program.
    if os.environ.get("NO_COLOR") is not None:
        return False
    if os.environ.get("FORCE_COLOR"):
        return True
    if not hasattr(stream, "isatty") or not stream.isatty():
        return False
    if os.environ.get("TERM") == "dumb":
        return False
    if os.name == "nt":
        # Windows 10+ can do ANSI, but only once the console mode is asked for.
        try:
            import ctypes
            k = ctypes.windll.kernel32
            handle = k.GetStdHandle(-11)
            mode = ctypes.c_uint32()
            if not k.GetConsoleMode(handle, ctypes.byref(mode)):
                return False
            return bool(k.SetConsoleMode(handle, mode.value | 0x0004))
        except Exception:
            return False
    return True


def _supports_unicode(stream):
    enc = getattr(stream, "encoding", None) or ""
    try:
        "█▏─│╭".encode(enc)
        return True
    except (LookupError, UnicodeEncodeError):
        return False


COLOUR = _supports_colour(sys.stdout)
UNICODE = _supports_unicode(sys.stdout)


def _c(code):
    return code if COLOUR else ""


class C:
    RESET = _c("\033[0m")
    BOLD = _c("\033[1m")
    DIM = _c("\033[2m")
    RED = _c("\033[91m")
    GREEN = _c("\033[92m")
    YELLOW = _c("\033[93m")
    BLUE = _c("\033[94m")
    MAGENTA = _c("\033[95m")
    CYAN = _c("\033[96m")
    GREY = _c("\033[90m")


def width():
    return max(60, min(shutil.get_terminal_size((88, 25)).columns, 100))


# ---------------------------------------------------------------- glyphs

if UNICODE:
    G = dict(tl="╭", tr="╮", bl="╰", br="╯", h="─", v="│",
             ok="✔", bad="✘", dot="●", arrow="→", bar="█", half="▏")
else:
    G = dict(tl="+", tr="+", bl="+", br="+", h="-", v="|",
             ok="ok", bad="XX", dot="*", arrow="->", bar="#", half="|")


BANNER = r"""
 █████╗ ███╗   ██╗██╗   ██╗██████╗ ██████╗ ██╗██████╗  ██████╗ ███████╗
██╔══██╗████╗  ██║╚██╗ ██╔╝██╔══██╗██╔══██╗██║██╔══██╗██╔════╝ ██╔════╝
███████║██╔██╗ ██║ ╚████╔╝ ██████╔╝██████╔╝██║██║  ██║██║  ███╗█████╗
██╔══██║██║╚██╗██║  ╚██╔╝  ██╔══██╗██╔══██╗██║██║  ██║██║   ██║██╔══╝
██║  ██║██║ ╚████║   ██║   ██████╔╝██║  ██║██║██████╔╝╚██████╔╝███████╗
╚═╝  ╚═╝╚═╝  ╚═══╝   ╚═╝   ╚═════╝ ╚═╝  ╚═╝╚═╝╚═════╝  ╚═════╝ ╚══════╝
"""

BANNER_ASCII = r"""
    _    _   _ _   _ ____  ____  ___ ____   ____ _____
   / \  | \ | | \ | | __ )|  _ \|_ _|  _ \ / ___| ____|
  / _ \ |  \| |  \| |  _ \| |_) || || | | | |  _|  _|
 / ___ \| |\  | |\  | |_) |  _ < | || |_| | |_| | |___
/_/   \_\_| \_|_| \_|____/|_| \_\___|____/ \____|_____|
"""


def _plain(text):
    """Length of text with ANSI escapes discounted, for padding."""
    out, i = 0, 0
    while i < len(text):
        if text[i] == "\033":
            i = text.find("m", i) + 1 or len(text)
            continue
        out += 1
        i += 1
    return out


def home_short(path):
    """~ for the home directory: paths are long and the prefix is never news."""
    home = os.path.expanduser("~").replace("\\", "/")
    p = str(path).replace("\\", "/")
    return "~" + p[len(home):] if p.lower().startswith(home.lower()) else p


# ---------------------------------------------------------------- panels

def rule(char=None, colour=None):
    print(f"{colour or C.GREY}{(char or G['h']) * width()}{C.RESET}")


def banner(version, port, roots, tools, unrestricted=False, no_bash=False):
    art = BANNER if UNICODE else BANNER_ASCII
    pad = " " * max(0, (width() - 71) // 2) if UNICODE else ""
    print()
    for line in art.strip("\n").splitlines():
        print(f"{C.CYAN}{C.BOLD}{pad}{line}{C.RESET}")
    tag = f"{pad}  local tools for any AI chat  {C.DIM}v{version}{C.RESET}"
    print(f"{C.GREY}{tag}{C.RESET}\n")

    def row(label, value, colour=""):
        print(f"  {C.GREY}{label:<9}{C.RESET} {colour}{value}{C.RESET}")

    row("listening", f"http://localhost:{port}", C.BOLD)
    row("pid", os.getpid())
    if unrestricted:
        row("sandbox", "DISABLED - file tools may touch anything you can", C.RED)
    else:
        row("sandbox", home_short(roots[0]) if roots else "?", C.GREEN)
        for extra in roots[1:]:
            print(f"  {'':<9} {C.GREEN}{home_short(extra)}{C.RESET}")
    # Worth its own line rather than leaving it to be noticed as an absence in
    # the tool list: with no shell the sandbox above is the whole boundary.
    if no_bash:
        row("shell", "none - bash was not loaded", C.GREEN)
    row("tools", f"{len(tools)}  {C.DIM}{' '.join(sorted(tools))}")
    print()


def ready():
    print(f"  {C.GREEN}{G['dot']}{C.RESET} {C.BOLD}ready{C.RESET} "
          f"{C.DIM}- prime a chat from the Tampermonkey menu to begin"
          f"  (ctrl-c to stop){C.RESET}\n")


TOOL_COLOUR = {
    "read": C.BLUE, "list": C.BLUE, "glob": C.BLUE, "grep": C.BLUE,
    "git_status": C.BLUE, "git_diff": C.BLUE, "watch_file": C.BLUE,
    "write": C.YELLOW, "edit": C.YELLOW, "replace_lines": C.YELLOW,
    "insert_lines": C.YELLOW, "mkdir": C.YELLOW, "copy": C.YELLOW,
    "move": C.YELLOW, "delete": C.RED, "bash": C.MAGENTA,
}


def describe(call):
    """One-line summary of a call: what it touches, and how much."""
    tool = call.get("tool", "?")
    if tool == "bash":
        return home_short(call.get("cmd", ""))[:70]
    target = home_short(call.get("path") or call.get("pattern") or "")
    detail = ""
    if tool == "read":
        off = call.get("offset", 1)
        detail = f"  from line {off}" if off and int(off) > 1 else ""
    elif tool in ("write", "insert_lines"):
        detail = f"  {len(call.get('lines') or [])} lines"
    elif tool == "replace_lines":
        detail = f"  lines {call.get('start')}-{call.get('end', call.get('start'))}"
    elif tool == "edit":
        old = (call.get("old") or "").strip().replace("\n", " ")
        detail = f"  {old[:34]!r}"
    elif tool in ("move", "copy"):
        detail = f"  {G['arrow']} {home_short(call.get('to', ''))}"
    elif tool == "grep":
        detail = f"  {call.get('pattern', '')!r}"
    return f"{target}{C.DIM}{detail}{C.RESET}"


def request_header(n, seq):
    stamp = time.strftime("%H:%M:%S")
    label = f" batch #{seq} {G['v']} {n} call{'s' if n != 1 else ''} "
    line = G["h"] * 2 + label
    print(f"\n{C.CYAN}{line}{G['h'] * max(0, width() - _plain(line))}{C.RESET}"
          f"{C.GREY} {stamp}{C.RESET}")


def call_line(i, call):
    tool = call.get("tool", "?")
    colour = TOOL_COLOUR.get(tool, C.RESET)
    print(f"  {C.GREY}{i:>2}{C.RESET} {colour}{tool:<14}{C.RESET}{describe(call)}")


def result_line(i, result, seconds):
    ok = result.get("ok")
    mark = f"{C.GREEN}{G['ok']}{C.RESET}" if ok else f"{C.RED}{G['bad']}{C.RESET}"
    took = f"{C.GREY}{seconds * 1000:.0f}ms{C.RESET}" if seconds < 1 \
        else f"{C.YELLOW}{seconds:.1f}s{C.RESET}"
    print(f"  {C.GREY}{i:>2}{C.RESET} {mark} {summarize(result)}  {took}")
    if not ok and result.get("hint"):
        print(f"     {C.GREY}{G['half']} {result['hint']}{C.RESET}")


def summarize(result):
    if not result.get("ok"):
        return f"{C.RED}{result.get('error', 'failed')}{C.RESET}"
    tool = result.get("tool")
    if tool == "read":
        return f"read {result.get('shown')} of {result.get('total_lines')} lines"
    if tool == "bash":
        out = (result.get("stdout") or "").splitlines()
        return out[0][:100] if out else f"{C.DIM}exit 0, no output{C.RESET}"
    if tool in ("glob", "list"):
        return f"{result.get('count', 0)} entries"
    if tool == "grep":
        return f"{result.get('files_matched', 0)} of {result.get('files_searched', 0)} files matched"
    if tool == "write":
        return f"{result.get('action')} ({result.get('lines_written')} lines)"
    if tool == "edit":
        return f"replaced {result.get('replaced')}"
    if tool in ("replace_lines", "insert_lines"):
        return f"now {result.get('total_lines')} lines"
    if tool in ("mkdir", "delete", "move", "copy"):
        return str(result.get("action", "ok"))
    return "ok"


def batch_footer(results, seconds):
    ok = sum(1 for r in results if r.get("ok"))
    bad = len(results) - ok
    parts = [f"{C.GREEN}{ok} ok{C.RESET}"]
    if bad:
        parts.append(f"{C.RED}{bad} failed{C.RESET}")
    print(f"  {C.GREY}{G['h'] * 3}{C.RESET} " + f"{C.GREY},{C.RESET} ".join(parts)
          + f" {C.GREY}in {seconds:.2f}s{C.RESET}")


def note(text, colour=None):
    print(f"  {colour or C.GREY}{text}{C.RESET}")


def farewell(stats, started):
    mins = (time.time() - started) / 60
    print(f"\n{C.GREY}{G['h'] * width()}{C.RESET}")
    print(f"  {C.BOLD}anybridge stopped{C.RESET} "
          f"{C.GREY}- {stats['batches']} batches, {stats['calls']} calls, "
          f"{stats['failed']} failed, up {mins:.0f} min{C.RESET}\n")
