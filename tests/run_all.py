"""
Run every suite. `python tests/run_all.py` from anywhere.

  --mutate   also run the mutation suite (slow: it re-runs the tests once per
             deliberately broken copy of the userscript)
  --bench    also run the throughput benchmark
"""
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

JS_SUITES = ["test_sites.js", "test_long.js", "test_stream.js", "test_scan.js"]
PY_SUITES = ["test_tools.py"]


def run(label, argv, tail=1):
    try:
        # The suites print emoji. Without an explicit utf-8 decode, subprocess
        # falls back to the console codepage, blows up on the first non-cp1252
        # byte and hands back nothing - which this runner then cheerfully
        # reported as a pass. Every suite read as "(no output)" and the summary
        # said ALL GREEN.
        out = subprocess.run(argv, cwd=ROOT, capture_output=True, text=True,
                             encoding="utf-8", errors="replace", timeout=600)
    except subprocess.TimeoutExpired:
        print(f"  {label:<24} TIMEOUT")
        return False
    text = (out.stdout or "") + (out.stderr or "")
    lines = [ln for ln in text.splitlines() if ln.strip()]
    if not lines and out.returncode == 0:
        # Silence is not success; a suite that says nothing was not observed.
        print(f"  {label:<24} NO OUTPUT - result unknown, treating as failure")
        return False
    print(f"  {label:<24} {(lines[-tail:] or ['(silent)'])[-1].strip()}")
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

    print("\n== python suites ==")
    for s in PY_SUITES:
        ok &= run(s, [sys.executable, os.path.join("tests", s)])

    print("\n== live captures replayed through the real adapters ==")
    ok &= run("verify_capture.js", ["node", os.path.join("probes", "verify_capture.js")])

    if "--mutate" in sys.argv:
        print("\n== mutation coverage ==")
        run("mutate_sites.js", ["node", os.path.join("tests", "mutate_sites.js")])

    if "--bench" in sys.argv:
        print("\n== benchmark ==")
        subprocess.run(["node", os.path.join("tests", "bench.js")], cwd=ROOT)

    print("\n" + ("ALL GREEN" if ok else "FAILURES ABOVE"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
