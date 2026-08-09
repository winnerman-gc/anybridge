# Anybridge

Local tools for any AI chat. The model emits a JSON block; a userscript reads it
out of the chat's response stream, POSTs it to a local agent, and pastes the
result back into the conversation. The chat gets typed file tools on your
machine — and a shell too, if you ask for one — with no API key and no extension
beyond a userscript manager.

![The agent's console: the sandbox it was given, a browser pairing with it, two
batches of tool calls, and the last one refused for pointing outside the
sandbox](docs/console.svg)

**The AI is the chat website you already use, not a CLI or an API.** There is no
model running here and no key to supply — you drive it by typing in ChatGPT or
Claude or Gemini in your browser, exactly as you normally would, and the plan
you already pay for is what powers it. This repo is only the two halves that
carry a tool call out of that conversation and the result back into it.

Works with ChatGPT, Claude, Gemini, Kimi, DeepSeek, Qwen and Grok. Five of those
are replayed from captured live traffic by the test suite, and a sixth was
verified live — see [`docs/SITES.md`](docs/SITES.md).

> **Read the [safety model](#safety-model) before you run this.** The agent gives
> a chat window real file access on the machine it runs on — bounded to
> directories you name, and with no shell unless you pass `--bash`. That is the
> point of it, and it is also the risk.

## Requirements

- **Python 3.10+** — standard library only, nothing to install
- **A userscript manager** — a browser extension that runs custom scripts on
  pages. [Tampermonkey](https://www.tampermonkey.net/) is the usual one
  (Chrome, Edge, Firefox, Safari); Violentmonkey works too. Install it from your
  browser's extension store before going further.
- **Node 18+** — only for the test suites and the traffic probes

Written and tested on Windows. The tool layer uses forward-slash paths
throughout and `bash` runs through the platform shell, so other platforms are
plausible but unverified.

## Setup

### 1. Get the code

```
git clone https://github.com/winnerman-gc/anybridge.git
cd anybridge
```

### 2. Start the agent, and tell it what it may touch

The directories you pass on the command line **are the sandbox**. The file tools
can act inside them and nowhere else, and the model is told exactly what they
are when you prime a chat.

```
python agent.py                        # default: the directory you are in
python agent.py C:/work/api            # only this project
python agent.py C:/work/api D:/notes   # several directories
python agent.py C:/work/api --bash     # ...and give it a shell
python agent.py --all                  # no sandbox at all
python agent.py C:/work/api --port 4000
```

**There is no shell unless you ask for one.** `bash` is the single tool no
directory list can bound — a shell command reaches whatever your account can,
wherever it lives — so loading it made the sandbox a bound on twelve tools out
of thirteen rather than a boundary. It is off by default. Without it, the
directories above really are the whole of what a chat can reach.

`--bash` loads it back when you want the model to run your tests or your build.
That is a real convenience and a real escalation; take it deliberately, and
prefer a narrow sandbox when you do. The served prompt is rewritten to match
whichever way you run, so the model is never told about a tool it does not have.

A directory that does not exist is rejected rather than silently becoming a
sandbox that allows nothing. `--all` refuses to take directories, because then
the banner and the model's prompt would disagree about what is reachable.

Environment variables still work and are useful for a shortcut or a shell
profile: `BRIDGE_ROOTS` (an `os.pathsep`-separated list, or `*` for
unrestricted) and `BRIDGE_PORT`. Command-line arguments win over both.

The banner prints what it settled on — check the `sandbox` line matches what you
intended before you start a chat:

```
  listening http://localhost:3456
  pid       5896
  sandbox   C:/work/api
  shell     none - bash was not loaded
  tools     12  copy delete edit glob grep insert_lines list mkdir move ...
```

Run with `--bash` and the shell line disappears, because there is a shell:

```
  sandbox   C:/work/api
  tools     13  bash copy delete edit glob grep insert_lines list mkdir ...
```

### 3. Install the userscript

Open `userscript/bridge.user.js` and copy the whole file. Then, in the
Tampermonkey extension: click its icon in the browser toolbar → **Create a new
script**, replace whatever is in the editor with what you copied, and save
(Ctrl+S).

It matches every page but stays dormant except on chat sites it knows.

**Upgrading from 1.0?** Re-copy the script. The two halves now agree a token
before the agent will run anything, and a 1.0 script does not know how to ask
for one — so it gets refused by a 1.1 agent, with `refused a request with a
missing or stale token` in the agent console. The badge in your browser console
says which one you have.

### 4. Prime a chat

Open a supported chat, then click the Tampermonkey icon in the toolbar — the
script's commands appear in that dropdown — and choose **Prime this chat with
the system prompt**. That fetches the prompt from the running agent and sends it
as the first message.

Priming rather than pasting the file by hand matters: the agent fills in the
`WORKSPACE` section with the directories it is *actually* running with, so the
model is told the truth about its sandbox. Paste `prompts/sys_prompt.txt`
manually and it still contains the literal `{{WORKSPACE}}` placeholder.

The model should reply `Bridge online. Tool mode, Windows. Ready.` — then give
it a task.

### Checking it works

The browser console shows a badge reading `anybridge v1.1 <site>` on an active
site. From there:

- The agent console prints `paired with a browser` the first time the userscript
  reaches it, and then every call it runs. That is the quickest confirmation
  both halves are alive.
- Ask the chat to list one of your sandbox directories and watch it appear.

Do **not** test the agent by curling it. The token is handed out once per run,
so a `curl .../pair` takes the pairing your browser needs and the bridge stops
working until you restart the agent.

If nothing fires, the console log tells you which half is quiet: no badge means
the userscript is not active on that site, and a badge with no agent traffic
usually means the block never left the model's reasoning trace.

### Keyboard shortcuts

| Keys | What it does |
|---|---|
| **Ctrl+Shift+B** | Adopt (or drop) the current site, for a chat with no adapter. Reload afterwards. |
| **Ctrl+Shift+R** | Clear this browser's executed-id records and rescan, so a block can run again. |

## Layout

```
agent.py              HTTP entry point - this is what you run
                      POST /  runs a batch of calls
                      GET /health   agent status and tool list
                      GET /prompt   the system prompt, workspace filled in
                      GET /pair     hands the browser this run's token, once
bridge/               the tool layer
  tools.py            16 tools: read, write, edit, replace_lines,
                      insert_lines, apply_patch, list, glob, grep, mkdir,
                      move, copy, delete, git_status, git_diff,
                      watch_file - plus bash behind --bash, and the allowlist
  render.py           turns results into the plain text pasted back
  console.py          the agent's terminal output
userscript/           the browser half, including the per-site stream adapters
prompts/sys_prompt.txt what the model is told it can do
docs/SITES.md         per-site protocols, and how to add or re-verify one
docs/console.svg      the picture above - regenerate it with
                      docs/make_console_image.py after changing the console
tests/                suites, plus fixtures/ holding real captured traffic
probes/               tools for inspecting a live chat's network traffic
```

## Tests

```
python tests/run_all.py            # 293 tests + 5 live captures replayed
python tests/run_all.py --mutate   # also check the tests can actually fail (15 mutations)
python tests/run_all.py --bench    # throughput
```

`--mutate` is worth understanding: it breaks one safety check at a time and
confirms a test notices. Several guards here looked correct but were dead code,
and only mutation testing showed it.

## Safety model

- **Directory allowlist.** File tools are confined to the directories given to
  `agent.py`, defaulting to the one you start it in. Links are resolved before
  the check, so a symlink or junction inside a root cannot walk out of it —
  which matters because ordinary project trees are full of them.
- **No shell unless asked.** `bash` is the one tool no directory list can bound,
  so it is loaded only with `--bash`.
- **Only your browser can reach the agent.** Web pages are locked out by a
  required header they cannot send plus a `Host` check; local programs by a
  token the agent hands out once per run, which the userscript claims by itself.
- **Read before write.** Modifying a file requires having read the lines being
  changed — not merely having opened the file once. Overwriting a whole file
  requires having read all of it. Writing counts as reading, since the model
  supplied every line — but if the file then changes on disk (your editor, a
  build, a checkout) the record expires and it must look again first.
- **Delete is strictest.** A file must be known before it is destroyed; a
  non-empty directory needs explicit `"recursive": true`. An allowed root cannot
  be deleted at all.
- **Replay protection.** Each block executes once per chat, by its `id` — or,
  when it has none, by a hash of the calls themselves, so an id-less block
  cannot run again just because its text came back round on a reload.
- **A repaired payload may edit, but may not run a shell.** Malformed JSON gets
  one repair attempt; since that rewrites the text, a `bash` call which only
  parsed after repair is refused rather than guessed at.
- **Reasoning traces are never executed.** Every adapter drops the model's
  private thinking before the payload scan. On some sites reasoning and answer
  share one field, so this is the adapter's main job.
- **The prompt's own example is inert.** The system prompt teaches the format by
  showing a valid tool call. The script records what it primed a chat with and
  refuses to act on anything that came from it.
- **Only the model's own messages count.** A code block being on the page never
  meant the model wrote it — your own messages are on the page too. All seven
  supported sites name the container the assistant writes into, each measured in
  a live session, and nothing outside it is scanned. A host you adopt by hand
  has no such selector, so there a smaller subtractive filter is all that
  applies — see [`docs/SITES.md`](docs/SITES.md).

**`bash` is not sandboxed, which is why it is off by default.** A shell command
reaches anything your account can, whatever directories you passed to
`agent.py`; bounding a shell needs a container, not a path check. The twelve
tools you get without it are all bounded by the allowlist. Passing `--bash`
loads the one that is not — worth doing when you want tests run, worth doing
knowingly.

Even then, be honest about what a sandbox of files buys you. Anything inside it
that later gets *executed* — a script you run afterwards, a `.bashrc`, a
`package.json`, a git hook — is still a path to code execution, just a slower
one. A narrow sandbox of a single project directory is worth much more than a
wide one that includes your home tree.

Anything the model reads becomes part of its input, so a file containing
something shaped like an instruction is a prompt-injection vector. The allowlist
limits the blast radius; it does not remove the risk.

The agent binds `127.0.0.1` only. Do not expose the port; anything that can
reach it can run tools as you.

Binding localhost does **not**, by itself, keep out the web pages you have open
— a browser will send any site's `fetch()` to `localhost` quite happily, and
these tools run shell commands. Two things stop that:

- **Every request must carry an `X-Anybridge` header.** Sending one makes a
  cross-origin request non-simple, so the browser must preflight it first, and
  the agent refuses every preflight. That leaves only the request types that
  cannot set headers at all — forms, `no-cors` fetch — which are refused for
  lacking it. The userscript is unaffected: `GM_xmlhttpRequest` is privileged
  and never preflights.
- **Every request must also carry a token**, which the agent mints per run and
  hands out exactly once, to the first caller that asks. The userscript asks by
  itself — there is nothing to paste — and asks again when the agent restarts
  and its stored token stops working. That narrows the window for another local
  program from the whole run to one moment at startup, and losing the race is
  loud rather than silent: the bridge stops working and the console says another
  client took the pairing. It is not a wall against local malware, and nothing
  can be: a program running as you can read your files without this agent's
  help.
- **The `Host` header must be localhost.** Otherwise an attacker's domain whose
  DNS answers `127.0.0.1` is same-origin with the agent by the browser's own
  rules, and an origin allowlist would prove nothing. That is DNS rebinding.

The agent also sends no `Access-Control-Allow-Origin` header at all, so no site
can read a reply even if it manages to provoke one.

For the full threat model — including what is deliberately *not*
defended — see [SECURITY.md](SECURITY.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). In short: `python tests/run_all.py` must
be green, new guards need a mutation test that fails without them, and new site
adapters must be built from captured traffic rather than from memory.

## License

MIT — see [LICENSE](LICENSE).
