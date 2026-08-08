"""
Typed tool layer for the AI bridge.

Design constraints imposed by the transport (LLM chat -> Tampermonkey -> HTTP):
  * File content NEVER crosses the wire as a string with embedded newlines.
    The userscript's JSON sanitizer rewrites quoted spans and corrupts them.
    Content is always a JSON array of lines instead.
  * Every result is a plain dict, JSON-serializable, and size-capped.
  * Errors are returned as data (ok=False), never raised, so one bad call in a
    batch does not kill the rest.
"""

import os
import re
import fnmatch
import glob as globlib
import shutil
import subprocess

MAX_READ_LINES = 400          # per read call, unless caller overrides
MAX_LINE_CHARS = 500          # truncate absurdly long lines
MAX_RESULT_CHARS = 12000      # hard cap on any single tool's text payload
MAX_GREP_MATCHES = 100
MAX_READ_BYTES = 10 * 1024 * 1024   # refuse to slurp anything larger

# What the model has actually SEEN, per file: {path: {"total": n, "ranges": [(a, b)]}}
#
# Recording only "this path was read" is too weak to mean anything. Reading five
# lines of a two-thousand-line file would unlock replace_lines anywhere in it,
# so the guard would wave through exactly the blind overwrite it exists to stop.
# Ranges are tracked so a line-addressed write can be checked against the lines
# the model has in front of it.
_read_files = {}


def _mark_read(path, start, end, total):
    rec = _read_files.setdefault(path, {"total": total, "ranges": []})
    rec["total"] = total
    if end >= start:
        rec["ranges"].append((start, end))


def _mark_full(path, total):
    """The model knows the whole file - it just supplied every line of it."""
    _read_files[path] = {"total": total, "ranges": [(1, total)] if total else []}


def _invalidate(path):
    """Content shifted, so old line numbers no longer describe this file."""
    if path in _read_files:
        _read_files[path]["ranges"] = []


def _covers(path, start, end):
    rec = _read_files.get(path)
    if not rec:
        return False
    need = set(range(start, end + 1))
    for a, b in rec["ranges"]:
        need -= set(range(a, b + 1))
        if not need:
            return True
    return not need


# ---------------------------------------------------------------- path policy
#
# The file tools are driven by an LLM whose input includes the contents of files
# it reads, so a prompt-injection in any file it opens becomes a tool call it
# might make. Bounding WHERE those tools can act is the difference between a bad
# suggestion and an overwritten system directory.
#
# Default: the user's home tree plus C:/temp. That covers ordinary project work
# while excluding C:/Windows, Program Files, and other users. Override with
# BRIDGE_ROOTS as an os.pathsep-separated list; set BRIDGE_ROOTS=* to disable
# (and accept that read/write/edit can then touch anything this account can).

def _default_roots():
    home = os.path.expanduser("~").replace('\\', '/')
    roots = [home, "C:/temp", os.environ.get("TEMP", "").replace('\\', '/')]
    return [r for r in roots if r]


def normalise_roots(paths):
    """Absolute, expanded, forward-slash - the shape ALLOWED_ROOTS holds."""
    return [os.path.abspath(os.path.expanduser(str(p).strip())).replace('\\', '/')
            for p in paths if str(p).strip()]


def parse_roots(spec):
    """
    Read a roots spec the way BRIDGE_ROOTS is written: "*" is unrestricted
    (None), an os.pathsep-separated list names directories, and nothing at all
    means the defaults above.
    """
    spec = "" if spec is None else str(spec).strip()
    if not spec:
        return normalise_roots(_default_roots())
    if spec == "*":
        return None                           # explicitly unrestricted
    return normalise_roots(spec.split(os.pathsep))


def set_roots(roots):
    """
    Replace the allowlist after import, for agent.py's command line. Every
    check reads the module global at call time, so no caller holds a stale
    copy - except one that did `from bridge.tools import ALLOWED_ROOTS`, which
    binds a snapshot. Read the return value or the module attribute instead.
    """
    global ALLOWED_ROOTS
    ALLOWED_ROOTS = None if roots is None else normalise_roots(roots)
    return ALLOWED_ROOTS


ALLOWED_ROOTS = parse_roots(os.environ.get("BRIDGE_ROOTS"))


def _within_roots(p):
    """True if p sits inside one of the allowed roots (case-insensitive on Windows)."""
    if ALLOWED_ROOTS is None:
        return True
    q = p.lower().rstrip('/')
    for root in ALLOWED_ROOTS:
        r = root.lower().rstrip('/')
        if q == r or q.startswith(r + '/'):
            return True
    return False


# ---------------------------------------------------------------- helpers

def _norm(path):
    """
    Accept either slash style, return an absolute FORWARD-slash path.
    Windows APIs accept forward slashes everywhere, and keeping them out of
    results is what stops backslash double-escaping from accumulating as the
    path travels back through JSON into the chat and out again.
    """
    return os.path.abspath(os.path.expanduser(str(path).replace('\\', '/'))).replace('\\', '/')


def _cap(text):
    if len(text) > MAX_RESULT_CHARS:
        return text[:MAX_RESULT_CHARS] + f"\n... [truncated, {len(text)} chars total]"
    return text


def _detect_eol(raw):
    return '\r\n' if raw.count('\r\n') > raw.count('\n') - raw.count('\r\n') else '\n'


def _looks_binary(path):
    """A NUL byte in the first block is the usual, cheap test."""
    try:
        with open(path, 'rb') as f:
            return b'\x00' in f.read(8192)
    except OSError:
        return False


def _load(path):
    """
    Return (lines, eol, trailing_newline).

    The final newline is carried as a flag, NOT as a trailing empty element.
    Splitting "a\\nb\\nc\\n" on newlines yields four items, so representing the
    file that way reported three lines as four and invented an empty last line -
    which then shifted every line number the model was given, and let it address
    a line that does not exist.
    """
    with open(path, 'r', encoding='utf-8', errors='replace', newline='') as f:
        raw = f.read()
    eol = _detect_eol(raw)
    if raw == '':
        return [], eol, False
    lines = raw.replace('\r\n', '\n').split('\n')
    trailing = lines[-1] == ''
    if trailing:
        lines.pop()
    return lines, eol, trailing


def _save(path, lines, eol, trailing=True):
    """
    Write lines back. `trailing` adds the final newline a text file should have.

    Files the bridge created previously ended mid-line: git reports
    "\\ No newline at end of file", and POSIX tools that read line-by-line drop
    or mangle the last one.
    """
    os.makedirs(os.path.dirname(path) or '.', exist_ok=True)
    body = eol.join(lines)
    if trailing and lines:
        body += eol
    with open(path, 'w', encoding='utf-8', newline='') as f:
        f.write(body)


def _err(msg, **extra):
    return dict(ok=False, error=msg, **extra)


def _numbered(lines, start):
    width = len(str(start + len(lines) - 1))
    out = []
    for i, ln in enumerate(lines, start):
        if len(ln) > MAX_LINE_CHARS:
            ln = ln[:MAX_LINE_CHARS] + f" ...[+{len(ln) - MAX_LINE_CHARS} chars]"
        out.append(f"{str(i).rjust(width)}\t{ln}")
    return "\n".join(out)


def _guard_write(path):
    """An existing file must have been read before it is modified."""
    if os.path.exists(path) and path not in _read_files:
        return _err("must read file before modifying it",
                    hint=f'call {{"tool":"read","path":"{path}"}} first')
    return None


# ---------------------------------------------------------------- tools

def t_read(path, offset=1, limit=MAX_READ_LINES, **_):
    """Read a file as numbered lines. offset is 1-based."""
    p = _norm(path)
    if not os.path.exists(p):
        return _err(f"no such file: {p}")
    if os.path.isdir(p):
        return _err(f"is a directory (use list): {p}")
    try:
        size = os.path.getsize(p)
    except OSError:
        size = 0
    if size > MAX_READ_BYTES:
        return _err(f"file is {size} bytes; too large to read ({MAX_READ_BYTES} max)",
                    hint='use grep to find what you need, or bash for a targeted extract')
    # Decoding a binary file with errors="replace" yields thousands of
    # replacement characters that look like content, cost a fortune in context
    # and cannot be edited back correctly.
    if _looks_binary(p):
        return _err("file appears to be binary", hint="not readable as text; use bash if you need its bytes")
    try:
        lines, _eol, _tr = _load(p)
    except Exception as e:
        return _err(f"{type(e).__name__}: {e}")

    offset = max(1, int(offset))
    limit = max(1, int(limit))
    window = lines[offset - 1: offset - 1 + limit]
    end = offset + len(window) - 1
    _mark_read(p, offset, end, len(lines))

    return dict(ok=True, path=p, total_lines=len(lines),
                shown=f"{offset}-{end}",
                more=end < len(lines),
                content=_cap(_numbered(window, offset)))


def t_write(path, lines=None, eol=None, **_):
    """
    Create or fully replace a file. `lines` is a list of strings.

    eol: "lf" (default for new files) or "crlf". An existing file keeps whatever
    it already uses, so a write never silently rewrites every line ending.
    """
    p = _norm(path)
    if lines is None or not isinstance(lines, list):
        return _err('"lines" must be a list of strings')
    blocked = _guard_write(p)
    if blocked:
        return blocked
    existed = os.path.exists(p)

    # Overwriting the whole file means discarding every line of it, so the model
    # must have seen every line - not just opened the file once.
    if existed:
        rec = _read_files.get(p, {})
        if not _covers(p, 1, rec.get("total", 0)):
            return _err("write replaces the whole file, but you have not read all of it",
                        hint=f'read {p} in full first (it has {rec.get("total", "?")} lines), '
                             'or use edit / replace_lines to change part of it')

    # New files default to LF. os.linesep made every file created on Windows
    # CRLF, including shell scripts and anything destined for a repo.
    if existed:
        line_ending = _load(p)[1]
    else:
        line_ending = {'crlf': '\r\n', 'lf': '\n'}.get(str(eol).lower(), '\n')

    body = [str(x) for x in lines]
    try:
        _save(p, body, line_ending, trailing=True)
    except Exception as e:
        return _err(f"{type(e).__name__}: {e}")
    _mark_full(p, len(body))
    return dict(ok=True, path=p, action="overwrote" if existed else "created",
                lines_written=len(lines))


def t_edit(path, old=None, new=None, all=False, **_):
    """Exact string replacement. Fails unless `old` is unique (or all=True)."""
    p = _norm(path)
    if old is None or new is None:
        return _err('"old" and "new" are required')
    if not os.path.exists(p):
        return _err(f"no such file: {p}")
    blocked = _guard_write(p)
    if blocked:
        return blocked

    lines, eol, trailing = _load(p)
    text = "\n".join(lines)
    count = text.count(old)
    if count == 0:
        return _err("old string not found", hint="re-read the file; whitespace must match exactly")
    if count > 1 and not all:
        return _err(f"old string is not unique ({count} matches)",
                    hint='add surrounding context to make it unique, or pass "all": true')

    text = text.replace(old, new) if all else text.replace(old, new, 1)
    try:
        _save(p, text.split("\n"), eol, trailing)
    except Exception as e:
        return _err(f"{type(e).__name__}: {e}")
    _invalidate(p)      # an edit can add or remove lines; numbering has moved
    return dict(ok=True, path=p, replaced=count if all else 1)


def t_replace_lines(path, start=None, end=None, lines=None, **_):
    """Replace the inclusive 1-based line range [start, end] with `lines`."""
    p = _norm(path)
    if start is None or lines is None or not isinstance(lines, list):
        return _err('"start" and "lines" (list) are required')
    if not os.path.exists(p):
        return _err(f"no such file: {p}")
    blocked = _guard_write(p)
    if blocked:
        return blocked

    cur, eol, trailing = _load(p)
    start = int(start)
    end = int(end) if end is not None else start
    if start < 1 or end > len(cur) or start > end:
        return _err(f"bad range {start}-{end}; file has {len(cur)} lines")

    # These exact lines are about to be destroyed, so they are the ones that had
    # to be on screen. Having read some other part of the file proves nothing.
    if not _covers(p, start, end):
        return _err(f"lines {start}-{end} were not in what you read",
                    hint=f'read {p} covering lines {start}-{end} first, then retry '
                         'with the line numbers from that read')

    new = cur[:start - 1] + [str(x) for x in lines] + cur[end:]
    try:
        _save(p, new, eol, trailing)
    except Exception as e:
        return _err(f"{type(e).__name__}: {e}")
    _invalidate(p)
    return dict(ok=True, path=p, removed=end - start + 1, inserted=len(lines),
                total_lines=len(new))


def t_insert_lines(path, after=0, lines=None, **_):
    """Insert `lines` after the given 1-based line number (0 = top of file)."""
    p = _norm(path)
    if lines is None or not isinstance(lines, list):
        return _err('"lines" must be a list of strings')
    if not os.path.exists(p):
        return _err(f"no such file: {p}")
    blocked = _guard_write(p)
    if blocked:
        return blocked

    cur, eol, trailing = _load(p)
    after = int(after)
    if after < 0 or after > len(cur):
        return _err(f"bad position {after}; file has {len(cur)} lines")

    # Inserting destroys nothing, so only the position needs to be meaningful -
    # no range coverage is demanded, unlike replace_lines.
    new = cur[:after] + [str(x) for x in lines] + cur[after:]
    try:
        _save(p, new, eol, trailing)
    except Exception as e:
        return _err(f"{type(e).__name__}: {e}")
    _invalidate(p)
    return dict(ok=True, path=p, inserted=len(lines), total_lines=len(new))


def t_list(path=".", **_):
    """Directory listing with sizes."""
    p = _norm(path)
    if not os.path.isdir(p):
        return _err(f"not a directory: {p}")
    entries = []
    for name in sorted(os.listdir(p)):
        full = os.path.join(p, name)
        if os.path.isdir(full):
            entries.append(f"{name}/")
        else:
            try:
                entries.append(f"{name}  ({os.path.getsize(full)}b)")
            except OSError:
                entries.append(name)
    return dict(ok=True, path=p, count=len(entries), entries=entries[:300])


def t_glob(pattern=None, **_):
    """Filename pattern match. Supports ** for recursion."""
    if not pattern:
        return _err('"pattern" is required')
    pat = str(pattern).replace('\\', '/')
    try:
        hits = globlib.glob(pat, recursive=True)
    except Exception as e:
        return _err(f"{type(e).__name__}: {e}")
    hits = [h.replace(os.sep, '/') for h in hits]
    hits.sort(key=lambda h: -os.path.getmtime(h) if os.path.exists(h) else 0)
    return dict(ok=True, pattern=pat, count=len(hits), files=hits[:200])


def t_grep(pattern=None, path=".", glob="*", context=0, ignore_case=False, **_):
    """Regex search across files. Returns file:line:text hits."""
    if not pattern:
        return _err('"pattern" is required')
    root = _norm(path)
    try:
        rx = re.compile(pattern, re.IGNORECASE if ignore_case else 0)
    except re.error as e:
        return _err(f"bad regex: {e}")

    targets = []
    if os.path.isfile(root):
        targets = [root]
    else:
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames
                           if d not in ('.git', 'node_modules', '__pycache__', '.venv')]
            for fn in filenames:
                if fnmatch.fnmatch(fn, glob):
                    targets.append(os.path.join(dirpath, fn))

    hits, files_hit = [], set()
    for tgt in targets:
        if len(hits) >= MAX_GREP_MATCHES:
            break
        try:
            with open(tgt, 'r', encoding='utf-8', errors='replace') as f:
                flines = f.read().split('\n')
        except Exception:
            continue
        # Report paths relative to the search root -- absolute paths repeated on
        # every hit line burn an enormous amount of the chat context for nothing.
        rel = os.path.relpath(tgt, root).replace(os.sep, '/') if os.path.isdir(root) \
            else tgt.replace(os.sep, '/')
        for i, ln in enumerate(flines, 1):
            if rx.search(ln):
                files_hit.add(rel)
                ctx = int(context)
                lo, hi = max(1, i - ctx), min(len(flines), i + ctx)
                for j in range(lo, hi + 1):
                    mark = ':' if j == i else '-'
                    hits.append(f"{rel}{mark}{j}{mark}{flines[j - 1][:MAX_LINE_CHARS]}")
                if len(hits) >= MAX_GREP_MATCHES:
                    break
    return dict(ok=True, pattern=pattern, root=root, files_searched=len(targets),
                files_matched=len(files_hit), truncated=len(hits) >= MAX_GREP_MATCHES,
                matches=_cap("\n".join(hits)))


def t_mkdir(path=None, **_):
    """Create a directory, including parents."""
    if not path:
        return _err('"path" is required')
    p = _norm(path)
    if os.path.isdir(p):
        return dict(ok=True, path=p, action="already exists")
    if os.path.exists(p):
        return _err(f"exists and is not a directory: {p}")
    try:
        os.makedirs(p, exist_ok=True)
    except Exception as e:
        return _err(f"{type(e).__name__}: {e}")
    return dict(ok=True, path=p, action="created")


def _move_or_copy(path, to, overwrite, copy):
    if not path or not to:
        return _err('"path" and "to" are required')
    src, dst = _norm(path), _norm(to)
    if not os.path.exists(src):
        return _err(f"no such path: {src}")
    # Copying a directory onto itself, or moving a parent into its own child,
    # either loops forever or destroys the source.
    if dst == src or dst.startswith(src.rstrip('/') + '/'):
        return _err(f"destination is inside the source: {dst}")
    if os.path.exists(dst) and not overwrite:
        return _err(f"destination exists: {dst}",
                    hint='pass "overwrite": true to replace it')
    try:
        os.makedirs(os.path.dirname(dst) or '.', exist_ok=True)
        if os.path.exists(dst) and overwrite:
            shutil.rmtree(dst) if os.path.isdir(dst) else os.remove(dst)
        if copy:
            shutil.copytree(src, dst) if os.path.isdir(src) else shutil.copy2(src, dst)
        else:
            shutil.move(src, dst)
    except Exception as e:
        return _err(f"{type(e).__name__}: {e}")
    # The destination now holds exactly the source's content, so whatever the
    # model had seen of the source it has equally seen of the copy. Dropping
    # that would force a pointless re-read of a file it just produced, while
    # protecting nothing.
    rec = _read_files.get(src)
    if not copy:
        _read_files.pop(src, None)
    if rec:
        _read_files[dst] = {"total": rec["total"], "ranges": list(rec["ranges"])}
    else:
        _read_files.pop(dst, None)
    return dict(ok=True, path=src, to=dst, action="copied" if copy else "moved")


def t_move(path=None, to=None, overwrite=False, **_):
    """Move or rename a file or directory."""
    return _move_or_copy(path, to, overwrite, copy=False)


def t_copy(path=None, to=None, overwrite=False, **_):
    """Copy a file or directory."""
    return _move_or_copy(path, to, overwrite, copy=True)


def t_delete(path=None, recursive=False, **_):
    """
    Delete a file or directory.

    Deliberately the strictest tool here. A file must have been read first, on
    the same principle as overwriting one: nothing gets destroyed sight-unseen.
    A non-empty directory needs "recursive": true, stated explicitly.
    """
    if not path:
        return _err('"path" is required')
    p = _norm(path)
    if not os.path.exists(p):
        return _err(f"no such path: {p}")
    if ALLOWED_ROOTS and any(p.lower().rstrip('/') == r.lower().rstrip('/') for r in ALLOWED_ROOTS):
        return _err(f"refusing to delete an allowed root itself: {p}")

    if os.path.isdir(p):
        try:
            entries = os.listdir(p)
        except Exception as e:
            return _err(f"{type(e).__name__}: {e}")
        if entries and not recursive:
            return _err(f"directory is not empty ({len(entries)} entries): {p}",
                        hint='pass "recursive": true to delete it and everything in it')
        try:
            shutil.rmtree(p) if entries else os.rmdir(p)
        except Exception as e:
            return _err(f"{type(e).__name__}: {e}")
        return dict(ok=True, path=p, action="deleted directory", entries_removed=len(entries))

    if p not in _read_files:
        return _err("must read file before deleting it",
                    hint=f'call {{"tool":"read","path":"{p}"}} first')
    try:
        os.remove(p)
    except Exception as e:
        return _err(f"{type(e).__name__}: {e}")
    _read_files.pop(p, None)
    return dict(ok=True, path=p, action="deleted")


def t_bash(cmd=None, timeout=60, cwd=None, **_):
    """Escape hatch: run a shell command. Prefer the typed tools above."""
    if not cmd:
        return _err('"cmd" is required')
    try:
        proc = subprocess.run(cmd, shell=True, capture_output=True, text=True,
                              timeout=int(timeout),
                              cwd=_norm(cwd) if cwd else None)
    except subprocess.TimeoutExpired:
        return _err(f"timeout after {timeout}s", cmd=cmd, code=-1)
    except Exception as e:
        return _err(f"{type(e).__name__}: {e}", cmd=cmd, code=-1)
    return dict(ok=proc.returncode == 0, cmd=cmd, code=proc.returncode,
                stdout=_cap(proc.stdout.strip()), stderr=_cap(proc.stderr.strip()))


TOOLS = {
    "read": t_read,
    "write": t_write,
    "edit": t_edit,
    "replace_lines": t_replace_lines,
    "insert_lines": t_insert_lines,
    "list": t_list,
    "glob": t_glob,
    "grep": t_grep,
    "mkdir": t_mkdir,
    "move": t_move,
    "copy": t_copy,
    "delete": t_delete,
    "bash": t_bash,
}


def _check_paths(call):
    """
    Reject a call whose target lies outside the allowed roots.

    Enforced here rather than inside each tool so a tool added later cannot
    forget it. Note the honest limit: this bounds the FILE tools. `bash` runs a
    shell, so only its cwd is checked - the command itself can reach anywhere
    this account can, and no allowlist changes that.
    """
    # "to" is the destination of move/copy. Omitting it would let a move carry a
    # file straight out of the sandbox while only its source was checked.
    for key in ("path", "to", "cwd", "pattern"):
        raw = call.get(key)
        if not raw:
            continue
        # For glob patterns, only the literal prefix before any wildcard is a
        # real directory to test.
        text = str(raw)
        if key == "pattern":
            text = re.split(r'[*?\[]', text)[0]
        target = _norm(text)
        if not _within_roots(target):
            return _err(f"path outside allowed roots: {target}",
                        hint="allowed: " + ", ".join(ALLOWED_ROOTS or []) +
                             " (set BRIDGE_ROOTS to change, or BRIDGE_ROOTS=* to disable)")
    return None


def disable_tools(names):
    """
    Drop tools from the registry for this run. They then read to the model as
    unknown tools, which is the same answer a typo gets - there is no separate
    "disabled" state for it to argue with or try to re-enable.

    Removing bash is what turns the directory allowlist into a real boundary
    rather than a bound on twelve of thirteen tools.
    """
    return [n for n in names if TOOLS.pop(n, None) is not None]


def dispatch(call):
    """Run one tool call dict. Never raises."""
    if not isinstance(call, dict):
        return _err(f"call must be an object, got {type(call).__name__}")
    name = call.get("tool")
    if name not in TOOLS:
        return _err(f"unknown tool '{name}'", available=sorted(TOOLS))

    blocked = _check_paths(call)
    if blocked:
        blocked["tool"] = name
        return blocked

    args = {k: v for k, v in call.items() if k != "tool"}
    try:
        result = TOOLS[name](**args)
    except TypeError as e:
        return _err(f"bad arguments for '{name}': {e}")
    except Exception as e:
        return _err(f"{type(e).__name__}: {e}")
    result["tool"] = name
    # Failures return early without a path, which left the render showing a bare
    # "edit  ERROR" - unusable when a batch edits several files. Echo the target
    # back from the call so every result names what it acted on.
    if "path" not in result and "pattern" not in result:
        target = call.get("path") or call.get("pattern") or call.get("cmd")
        if target:
            result["path"] = _norm(target) if call.get("path") else target
    return result
