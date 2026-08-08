# Contributing

## Before you open a PR

```
python tests/run_all.py
```

must print `ALL GREEN`. If you touched a safety check in `bridge/tools.py` or a
guard in the userscript, also run:

```
python tests/run_all.py --mutate
```

That breaks one check at a time and confirms a test notices. Several guards in
this repo looked correct but were dead code, and only mutation testing showed
it. A new guard without a test that fails when the guard is removed is not
covered.

## Adding a chat site

Adapters live in the `SITES` table near the top of `userscript/bridge.user.js`.
Do not write one from memory — the frame shapes are not guessable, and every
site checked against real traffic turned out to differ from the guess. The
procedure is in `docs/SITES.md`, in short:

1. Capture real bytes with `probes/stream_probe_cdp.js` against a Chrome
   started with `--remote-debugging-port=9222`.
2. Save the capture into `tests/fixtures/` and check it with
   `probes/verify_capture.js`.
3. Write the adapter, add cases to `tests/test_sites.js`, and update the table
   in `docs/SITES.md` with what filters the reasoning trace out.

An adapter's main job is dropping the model's private reasoning before the
payload scan. On some sites reasoning and answer share one field. A PR that
does not show how reasoning is excluded will not be merged.

## Adding a tool

Tools are typed and registered in `bridge/tools.py`; rendering lives in
`bridge/render.py`; the model-facing description is `prompts/sys_prompt.txt`.
All three need updating together, plus tests in `tests/test_tools.py`. The
prompt is served to the browser over `GET /prompt`, so an edit to it reaches the
next primed chat without restarting anything. New
file-touching tools must respect the directory allowlist and the read-before-
write rule.

## Style

Match the surrounding code. Comments here explain why something is the way it
is, usually because the obvious version was wrong — keep that habit rather than
narrating what the code already says.

## Scope

Security reports: open an issue. Note that `bash` being unsandboxed is a known
and documented property, not a bug — see the safety model in the README.
