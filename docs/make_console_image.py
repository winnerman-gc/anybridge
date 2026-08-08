"""
Regenerate docs/console.svg - the picture of the agent in the README.

It is a rendering of real output, not a mock-up: the agent is started, a client
pairs with it, two batches of calls run, and the ANSI bytes it actually printed
are turned into SVG. Run it after changing anything the console prints, or the
picture quietly starts lying:

    python docs/make_console_image.py

Needs nothing but the standard library.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(HERE, "console.svg")
PORT = int(os.environ.get("BRIDGE_DEMO_PORT", 3541))

# The 16-colour palette the terminal would supply. Chosen to sit on the dark
# background below rather than to match any particular terminal exactly.
PALETTE = {
    "90": "#6b7280", "91": "#f87171", "92": "#4ade80", "93": "#fbbf24",
    "94": "#60a5fa", "95": "#c084fc", "96": "#22d3ee", "97": "#f5f5f5",
    "31": "#ef4444", "32": "#22c55e", "33": "#eab308", "34": "#3b82f6",
    "35": "#a855f7", "36": "#06b6d4", "37": "#d4d4d4",
}
FG = "#e5e7eb"
BG = "#0f1115"
CHAR_W = 8.42          # advance width of the font stack below at 14px
LINE_H = 17          # tight enough that the wordmark's block rows meet
PAD = 22


def capture():
    """Run a real session and return the bytes the agent printed."""
    # Deliberately NOT the system temp directory: on Windows that lives under
    # the user's profile, and the sandbox error prints its full path - which
    # would put whoever generated this picture's username in the README.
    work = "C:/temp/anybridge-demo" if os.name == "nt" else "/tmp/anybridge-demo"
    shutil.rmtree(work, ignore_errors=True)
    os.makedirs(work, exist_ok=True)
    os.makedirs(os.path.join(work, "src"), exist_ok=True)
    with open(os.path.join(work, "src", "app.py"), "w") as f:
        f.write("import os\n\n\ndef main():\n    print('hi')\n\n\n"
                "if __name__ == '__main__':\n    main()\n")
    with open(os.path.join(work, "README.md"), "w") as f:
        f.write("# demo project\n")

    env = {**os.environ, "FORCE_COLOR": "1", "PYTHONIOENCODING": "utf-8"}
    proc = subprocess.Popen([sys.executable, "-u", "agent.py", work, "--port", str(PORT)],
                            cwd=ROOT, env=env,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    try:
        time.sleep(2.5)
        head = {"Content-Type": "application/json", "X-Anybridge": "1"}

        def send(path, data=None, headers=None):
            req = urllib.request.Request("http://127.0.0.1:%d%s" % (PORT, path),
                                         data=data, method="POST" if data else "GET")
            for k, v in (headers or head).items():
                req.add_header(k, v)
            with urllib.request.urlopen(req, timeout=20) as r:
                return json.load(r)

        auth = dict(head, **{"X-Anybridge-Token": send("/pair")["token"]})
        w = lambda p: os.path.join(work, p).replace("\\", "/")

        send("/", json.dumps({"calls": [
            {"tool": "list", "path": w("")},
            {"tool": "read", "path": w("src/app.py")},
            {"tool": "grep", "pattern": "def ", "path": w("src")},
        ]}).encode(), auth)
        time.sleep(0.6)
        # The last call is refused: the picture should show the sandbox working,
        # not just the happy path.
        send("/", json.dumps({"calls": [
            {"tool": "edit", "path": w("src/app.py"),
             "old": "print('hi')", "new": "print('hello, world')"},
            {"tool": "write", "path": w("src/notes.md"),
             "lines": ["# notes", "", "written by the chat"]},
            {"tool": "read", "path": "C:/Windows/System32/drivers/etc/hosts"},
        ]}).encode(), auth)
        time.sleep(0.8)
    finally:
        proc.terminate()
        try:
            out = proc.communicate(timeout=10)[0]
        except subprocess.TimeoutExpired:
            proc.kill()
            out = proc.communicate()[0]
    shutil.rmtree(work, ignore_errors=True)
    return out.decode("utf-8", "replace")


SGR = re.compile(r"\x1b\[([0-9;]*)m")


def spans(line):
    """Split one line into (text, colour, bold, dim) runs."""
    out, pos = [], 0
    colour, bold, dim = None, False, False
    for m in SGR.finditer(line):
        if m.start() > pos:
            out.append((line[pos:m.start()], colour, bold, dim))
        for code in (m.group(1) or "0").split(";"):
            if code in ("", "0"):
                colour, bold, dim = None, False, False
            elif code == "1":
                bold = True
            elif code == "2":
                dim = True
            elif code in PALETTE:
                colour = PALETTE[code]
        pos = m.end()
    if pos < len(line):
        out.append((line[pos:], colour, bold, dim))
    return out


def esc(s):
    return (s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
             .replace('"', "&quot;"))


def render(text):
    lines = [ln.rstrip("\r") for ln in text.split("\n")]
    while lines and not SGR.sub("", lines[-1]).strip():
        lines.pop()
    width = max(len(SGR.sub("", ln)) for ln in lines)
    w = int(width * CHAR_W) + PAD * 2
    h = len(lines) * LINE_H + PAD * 2 + 34          # 34 = title bar

    # One <text> per line, and the runs inside it FLOW - no x on the tspans, no
    # textLength. Positioning each run at a column computed from an assumed
    # character width only works if that width matches the font the viewer
    # happens to have, and it never does on every machine: pin the runs and
    # short ones get stretched, leave them and the wordmark's block characters
    # shear apart. Letting a monospace font do what monospace fonts do is the
    # one approach that survives not knowing which font that is.
    rows = []
    for i, line in enumerate(lines):
        y = PAD + 34 + i * LINE_H
        parts = []
        for txt, colour, bold, dim in spans(line):
            if not txt:
                continue
            style = []
            if colour:
                style.append(f'fill="{colour}"')
            if bold:
                style.append('font-weight="bold"')
            if dim:
                style.append('opacity="0.62"')
            parts.append(f'<tspan {" ".join(style)}>{esc(txt)}</tspan>'
                         if style else esc(txt))
        if parts:
            rows.append(f'<text xml:space="preserve" x="{PAD}" y="{y}">'
                        f'{"".join(parts)}</text>')

    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" \
viewBox="0 0 {w} {h}" font-family="ui-monospace, 'Cascadia Mono', Consolas, \
'DejaVu Sans Mono', SFMono-Regular, Menlo, monospace" font-size="14">
  <rect width="{w}" height="{h}" rx="10" fill="{BG}"/>
  <rect width="{w}" height="34" rx="10" fill="#181b21"/>
  <rect y="24" width="{w}" height="10" fill="#181b21"/>
  <circle cx="20" cy="17" r="5.5" fill="#ff5f57"/>
  <circle cx="39" cy="17" r="5.5" fill="#febc2e"/>
  <circle cx="58" cy="17" r="5.5" fill="#28c840"/>
  <g fill="{FG}" xml:space="preserve">
{chr(10).join("    " + r for r in rows)}
  </g>
</svg>
'''


if __name__ == "__main__":
    svg = render(capture())
    with open(OUT, "w", encoding="utf-8", newline="\n") as f:
        f.write(svg)
    print(f"wrote {OUT} ({len(svg)} bytes)")
