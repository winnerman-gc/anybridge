# Security

## Reporting

Open an issue at https://github.com/winnerman-gc/anybridge/issues. If you would
rather not say it in public first, say so in an issue with no detail and I will
find another channel.

Please include what an attacker controls at the start, and what they get at the
end. The known and documented properties below are not bugs.

## What this thing is

A chat website emits a JSON block. A userscript in your browser reads it out of
the response stream, POSTs it to a Python agent on `localhost`, and pastes the
result back into the chat. The agent runs typed file tools — and a shell, if you
asked for one with `--bash`.

So the trust boundary is plain: **whatever the model emits gets executed**,
bounded only by the directories you named. There is no approval step. That is
the design, not an oversight, and it is worth deciding whether you want it
before you run it.

## What is defended

- **Directory allowlist.** Every file tool is bounded to the directories given
  to `agent.py` — by default, only the one you start it in. Paths are resolved
  through symlinks, junctions and reparse points before the check, so a link
  inside a root cannot walk out of it.
- **No shell by default.** `bash` is the one tool no directory list can bound.
  It is loaded only with `--bash`.
- **Web pages cannot reach the agent.** A required custom header forces a
  preflight for any cross-origin request, and every preflight is refused; the
  request types that can skip a preflight cannot set the header. A `Host` check
  blocks DNS rebinding, which would otherwise make an attacker's domain
  same-origin with `localhost`. No `Access-Control-Allow-Origin` is sent.
- **Other local programs are held off by a per-run token**, handed out once to
  the first caller that asks. The userscript claims it automatically.
- **Read before write.** A file cannot be modified without its current content
  having been read, or overwritten without all of it having been read.
- **Replay protection.** A block runs once per chat, keyed by its `id` or by a
  hash of its calls.
- **Reasoning traces are never executed.** Each site adapter drops the model's
  private thinking before the payload scan.
- **The system prompt's own example is inert.** The script records what it
  primed a chat with and will not act on anything from it.
- **A repaired payload may edit, but may not run a shell.**

## What is not defended, and will not be

- **Prompt injection.** Anything the model reads becomes its input. A file, a
  web page, a pasted log containing something shaped like a tool call can cause
  one to be emitted, and the bridge executes what the model emits. The allowlist
  limits the blast radius. Nothing here removes the risk.
- **`bash`, once you pass `--bash`.** A shell reaches whatever your account can,
  wherever it lives. Bounding it needs a container, not a path check.
- **A file sandbox is not an execution sandbox.** Anything writable inside it
  that later gets run — a script, a `.bashrc`, a `package.json`, a git hook — is
  a slower path to the same place. Prefer one narrow project directory.
- **Anything already running as you.** A program with your privileges can read
  your files and start its own shell without this agent. The pairing token
  raises the bar for casual access and makes an attempt visible; it is not a
  boundary against code that is already inside.
- **The moment between the check and the open.** A path checked and then
  re-pointed a moment later would be followed. Closing that needs the check and
  the open to be one operation, which the stdlib file APIs do not offer.
- **The DOM fallback's scope on a host you adopt by hand.** All seven supported
  sites name the container the assistant's messages live in, so nothing outside
  it is considered. An adopted host has no such selector, and only a small
  subtractive list of "this is the user's turn" markers applies there — so on
  one, a code block in your own message can still be executed. Do not adopt a
  site you do not trust. `docs/SITES.md` has the measured selectors and the
  procedure for measuring another.
- **What you send to the provider.** Results are pasted back into the chat, so
  file content the model reads leaves your machine for whichever AI company you
  are using. That is inherent to a bridge whose model runs in their cloud.

## If you are being careful

```
python agent.py C:/path/to/one/project
```

No `--bash`, no `--all`, and not the directory holding the bridge's own source
(the agent warns when it is, because a chat could edit the guards bounding it).
