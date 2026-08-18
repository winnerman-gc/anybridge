"""
Run every suite. `python tests/run_all.py` from anywhere.

  --mutate   also run the mutation suite (slow: it re-runs the tests once per
             deliberately broken copy of the userscript)
  --bench    also run the throughput benchmark
"""
import os
import subprocess
import sys

# The suites print emoji, and this runner echoes their last line. A Windows
# console defaults to cp1252, so echoing one killed the whole run with a
# UnicodeEncodeError - after the suite had already passed.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

JS_SUITES = ["test_sites.js", "test_long.js", "test_stream.js", "test_scan.js",
             "test_image.js"]
PY_SUITES = ["test_tools.py"]

# The scan suite runs four times, because the DOM path behaves differently
# depending on what the adapter knows and the modes fail in opposite directions.
# The default is Qwen: an answer selector AND a virtualising editor (Monaco).
# z.ai has the same shape but a different virtualising editor (CodeMirror), so
# it re-exercises the generalised site.monaco selector rather than a hardcoded
# one. Claude has an answer selector and no virtualising editor. An adopted
# host has neither, so only the subtractive "this is the user's turn" filters
# apply there.
JS_VARIANTS = [
    ("test_scan.js  (zai: scoped, codemirror)", "test_scan.js",
     {"BRIDGE_TEST_URL": "https://chat.z.ai/c/abc123"}),
    ("test_scan.js  (claude: scoped, no monaco)", "test_scan.js",
     {"BRIDGE_TEST_URL": "https://claude.ai/chat/abc123"}),
    ("test_scan.js  (adopted host: unscoped)", "test_scan.js",
     {"BRIDGE_TEST_URL": "https://chat.example.test/c/abc123"}),
    # Qwen is the only site with a measured attach path. Everywhere else the
    # right behaviour is to fetch nothing and say the picture is not there.
    ("test_image.js (no attach path)", "test_image.js",
     {"BRIDGE_TEST_URL": "https://chatgpt.com/c/abc123"}),
]


def run(label, argv, tail=1, env=None):
    try:
        # The suites print emoji. Without an explicit utf-8 decode, subprocess
        # falls back to the console codepage, blows up on the first non-cp1252
        # byte and hands back nothing - which this runner then cheerfully
        # reported as a pass. Every suite read as "(no output)" and the summary
        # said ALL GREEN.
        out = subprocess.run(argv, cwd=ROOT, capture_output=True, text=True,
                             encoding="utf-8", errors="replace", timeout=600,
                             env={**os.environ, **(env or {})})
    except subprocess.TimeoutExpired:
        print(f"  {label:<24} TIMEOUT")
        return False
    text = (out.stdout or "") + (out.stderr or "")
    lines = [ln for ln in text.splitlines() if ln.strip()]
    if not lines and out.returncode == 0:
        # Silence is not success; a suite that says nothing was not observed.
        print(f"  {label:<24} NO OUTPUT - result unknown, treating as failure")
        return False
    # Report the suite's VERDICT, not merely its last line. A suite whose
    # subject logs asynchronously can print a stray warning after its summary,
    # and echoing that reads as a failure for a run that passed.
    verdict = next((ln for ln in reversed(lines)
                    if "PASS" in ln or "FAIL" in ln or "fired" in ln
                    or "mutations" in ln),
                   (lines[-tail:] or ["(silent)"])[-1])
    print(f"  {label:<24} {verdict.strip()}")
    if out.returncode != 0:
        for ln in text.splitlines():
            if "FAIL" in ln or "Error" in ln:
                print(f"      {ln.strip()}")
    return out.returncode == 0


def main():
    ok = True
    print("== syntax ==")
    # node --check is silent on success, so judge it by exit status alone.
    chk = subprocess.run(["node", "--check", os.path.join("userscript", "bridge.user.js")],
                         cwd=ROOT, capture_output=True)
    if chk.returncode:
        print("  userscript               SYNTAX ERROR")
        ok = False
    for f in ("agent.py", "bridge/tools.py", "bridge/render.py"):
        r = subprocess.run([sys.executable, "-c",
                            f"import ast;ast.parse(open(r'{os.path.join(ROOT, f)}',encoding='utf-8').read())"],
                           capture_output=True)
        if r.returncode:
            print(f"  {f:<24} SYNTAX ERROR")
            ok = False
    print("  python + js parse clean")

    print("\n== javascript suites ==")
    for s in JS_SUITES:
        ok &= run(s, ["node", os.path.join("tests", s)])
    for label, suite, env in JS_VARIANTS:
        ok &= run(label, ["node", os.path.join("tests", suite)], env=env)

    print("\n== python suites ==")
    for s in PY_SUITES:
        ok &= run(s, [sys.executable, os.path.join("tests", s)])

    print("\n== live captures replayed through the real adapters ==")
    ok &= run("verify_capture.js", ["node", os.path.join("probes", "verify_capture.js")])

    if "--mutate" in sys.argv:
        print("\n== mutation coverage ==")
        # Counted towards the verdict. An undetected mutation - or an anchor
        # that stopped matching, which is how they go quiet - is a hole in the
        # tests, and a run that prints ALL GREEN under one is worse than useless.
        ok &= run("mutate_sites.js", ["node", os.path.join("tests", "mutate_sites.js")])

    if "--bench" in sys.argv:
        print("\n== benchmark ==")
        subprocess.run(["node", os.path.join("tests", "bench.js")], cwd=ROOT)

    print("\n" + ("ALL GREEN" if ok else "FAILURES ABOVE"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
