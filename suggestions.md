# Suggestions — roadmap (revised)

The first draft of this file proposed ten features. Security review rejected
most of them. This revision keeps only what survives and records why the rest
were dropped, so the reasoning is not lost.

Ground rules for anything added to this project:
  * Standard library only — nothing to pip-install (the front-page promise).
  * The default install stays bounded. No new tool may reintroduce unbounded
    execution or an outbound-data channel.
  * Every write path honours read-before-write and invalidates the line cache.

## Worth building

### apply_patch — a unified-diff applier
The one idea that survives. It addresses a real weakness: `edit` needs an
exact string match and `replace_lines` needs correct line numbers, and both
fail when the model miscounts or mis-spaces. Models emit unified diffs more
reliably than either.

Why the first draft was rejected, and what the fix must do:
  * Read-before-write: the draft called `git apply`, which writes files with
    no read-before-write check — a hole in the guard. The fix enforces that
    every file the patch touches is already in the read cache before any hunk
    is applied.
  * Invalidate: the draft never invalidated the line-number cache. The fix
    calls `_invalidate()` on every touched file after applying.
  * No shell-out: do not use `git apply`. Parse and apply the diff in-process
    (stdlib only) so every write goes through the same guarded path as `write`,
    and no git dependency is introduced.
  * Allowlist: resolve each target path and check it against ALLOWED_ROOTS.

Shape:
  { "tool": "apply_patch", "patch": "<unified diff>", "dry_run": false }

## Rejected, and why

  * spawn / background processes — `shell=True` is bash under another name.
    It would hand the default install back the unbounded execution that is
    deliberately opt-in. Even gated behind --bash it duplicates bash itself,
    so it adds surface without capability.
  * http_get / fetch — an allowlist on the first hostname does not stop
    redirects to localhost or elsewhere, and more fundamentally, file-read
    plus outbound HTTP is an exfiltration channel: injected content could send
    file contents out. That conflicts with the whole security model.
  * mem_set / mem_get — persisting model-writable memory across sessions turns
    a single prompt injection into a permanent one; outside the sandbox it is
    worse. A memory feature would need to be user-owned, not model-writable.
  * clipboard_read — the clipboard routinely holds passwords and tokens, and
    reading it hands them to a third-party chat. A write-only variant is
    possible but low value.
  * tree-sitter editing, BM25 search — both require pip installs, breaking the
    stdlib-only promise, and the sketches were stubs regardless.
