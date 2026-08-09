"""
Renders tool results as plain text for the model to read.

Why not just paste the JSON: file content inside a JSON string arrives as one
enormous line of \\n and \\t escapes. The model then has to decode that to
reconstruct indentation before it can produce an `edit` whose `old` matches the
file byte-for-byte. That decoding step is where exact-match editing goes wrong,
so the content never gets escaped in the first place.

The JSON results still travel over HTTP unchanged; this only governs what gets
pasted back into the chat.
"""

SENTINEL = "=== BRIDGE RESULT"
END_SENTINEL = "=== END BRIDGE RESULT ==="

MAX_RENDER_CHARS = 30000   # backstop; tools.py already caps each payload


def _status(r):
    return "ok" if r.get("ok") else "ERROR"


def _fail(r):
    """Error line plus hint. The hint usually names the exact fix."""
    out = [f"    {r.get('error', 'failed')}"]
    if r.get("hint"):
        out.append(f"    hint: {r['hint']}")
    if r.get("available"):
        out.append(f"    available tools: {', '.join(r['available'])}")
    return out


def _render_one(index, r):
    tool = r.get("tool", "?")
    ok = r.get("ok")
    head = f"[{index}] {tool}"
    lines = []

    if tool == "bash":
        lines.append(f"{head}  {r.get('cmd', '')}  {_status(r)}  exit {r.get('code', '?')}")
        if not ok and r.get("error"):
            lines += _fail(r)
        if r.get("stdout"):
            lines.append("stdout:")
            lines.append(r["stdout"])
        if r.get("stderr"):
            lines.append("stderr:")
            lines.append(r["stderr"])
        if ok and not r.get("stdout") and not r.get("stderr"):
            lines.append("(no output)")
        return lines

    path = r.get("path") or r.get("pattern") or ""

    if not ok:
        lines.append(f"{head}  {path}  ERROR")
        lines += _fail(r)
        return lines

    if tool == "read":
        lines.append(f"{head}  {path}  ok  lines {r.get('shown')} of {r.get('total_lines')}")
        lines.append(r.get("content", ""))
        if r.get("more"):
            shown_end = int(str(r.get("shown", "1-1")).split("-")[-1])
            remaining = r.get("total_lines", 0) - shown_end
            lines.append(f'    ... {remaining} more lines; continue with "offset": {shown_end + 1}')

    elif tool == "write":
        lines.append(f"{head}  {path}  ok  {r.get('action')} ({r.get('lines_written')} lines)")

    elif tool == "edit":
        lines.append(f"{head}  {path}  ok  replaced {r.get('replaced')} occurrence(s)")

    elif tool == "replace_lines":
        lines.append(f"{head}  {path}  ok  removed {r.get('removed')}, inserted "
                     f"{r.get('inserted')} (file now {r.get('total_lines')} lines)")

    elif tool == "insert_lines":
        lines.append(f"{head}  {path}  ok  inserted {r.get('inserted')} "
                     f"(file now {r.get('total_lines')} lines)")

    elif tool in ("mkdir", "delete"):
        extra = f" ({r['entries_removed']} entries)" if r.get("entries_removed") else ""
        lines.append(f"{head}  {path}  ok  {r.get('action')}{extra}")

    elif tool in ("move", "copy"):
        lines.append(f"{head}  {path}  ok  {r.get('action')} -> {r.get('to')}")

    elif tool == "list":
        lines.append(f"{head}  {path}  ok  {r.get('count')} entries")
        lines += [f"  {e}" for e in r.get("entries", [])]

    elif tool == "glob":
        lines.append(f"{head}  {path}  ok  {r.get('count')} files")
        lines += [f"  {f}" for f in r.get("files", [])]

    elif tool == "grep":
        lines.append(f"{head}  {path}  ok  {r.get('files_matched')} of "
                     f"{r.get('files_searched')} files matched"
                     + ("  (truncated)" if r.get("truncated") else ""))
        if r.get("root"):
            lines.append(f"    paths relative to {r['root']}")
        if r.get("matches"):
            lines.append(r["matches"])
        else:
            lines.append("(no matches)")

    elif tool == "git_status":
        branch = r.get("branch") or "(detached)"
        lines.append(f"{head}  {r.get('cwd', '')}  ok  {branch}  "
                     f"{r.get('changed', 0)} changed")
        lines.append(r["status"] if r.get("status") else "(clean)")

    elif tool == "git_diff":
        which = "staged" if r.get("staged") else "working tree"
        lines.append(f"{head}  {r.get('cwd', '')}  ok  {which}, "
                     f"{r.get('files', 0)} file(s)")
        lines.append(r["diff"] if r.get("diff") else "(no changes)")

    elif tool == "watch_file":
        grew = r.get("grew")
        extra = f", {grew:+d} bytes" if grew else ""
        lines.append(f"{head}  {path}  ok  {r.get('status')}"
                     f"  ({r.get('size')} bytes{extra})")

    elif tool == "apply_patch":
        verb = "would apply" if r.get("dry_run") else "applied"
        lines.append(f"{head}  {path}  ok  {verb} patch to {r.get('files', 0)} file(s)")
        for a in r.get("applied", []):
            lines.append(f"  {a}")

    else:
        lines.append(f"{head}  {path}  ok")
        lines += [f"    {k}: {v}" for k, v in r.items()
                  if k not in ("ok", "tool", "path", "pattern")]

    return lines


def render_results(results):
    """Full plain-text render of one batch of tool results."""
    n = len(results)
    out = [f"{SENTINEL} ({n} call{'s' if n != 1 else ''}) ==="]
    for i, r in enumerate(results, 1):
        out.append("")
        out += _render_one(i, r)
    out.append("")
    out.append(END_SENTINEL)

    text = "\n".join(out)
    if len(text) > MAX_RENDER_CHARS:
        text = (text[:MAX_RENDER_CHARS]
                + f"\n... [render truncated at {MAX_RENDER_CHARS} chars]\n"
                + END_SENTINEL)
    return text
