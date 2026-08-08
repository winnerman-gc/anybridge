# Anybridge

Local tools for any AI chat. The model emits a JSON block; a userscript reads it
out of the chat's response stream, POSTs it to a local agent, and pastes the
result back into the conversation. The chat gets typed file and shell tools on
your machine, with no API key and no extension beyond a userscript manager.

**The AI is the chat website you already use, not a CLI or an API.** There is no
model running here and no key to supply — you drive it by typing in ChatGPT or
Claude or Gemini in your browser, exactly as you normally would, and the plan
you already pay for is what powers it. This repo is only the two halves that
carry a tool call out of that conversation and the result back into it.

Works with ChatGPT, Claude, Gemini, Kimi, DeepSeek, Qwen and Grok. Five of those
are replayed from captured live traffic by the test suite, and a sixth was
verified live — see [`docs/SITES.md`](docs/SITES.md).

> **Read the [safety model](#safety-model) before you run this.** The agent gives
> a chat window real file access and an unsandboxed shell on the machine it runs
> on. That is the point of it, and it is also the risk.

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
python agent.py                        # default: your home tree + C:/temp
python agent.py C:/work/api            # only this project
python agent.py C:/work/api D:/notes   # several directories
python agent.py --all                  # no sandbox at all
python agent.py C:/work/api --port 4000
```

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
  tools     13  bash copy delete edit glob grep insert_lines list mkdir ...
```

### 3. Install the userscript

Open `userscript/bridge.user.js` and copy the whole file. Then, in the
Tampermonkey extension: click its icon in the browser toolbar → **Create a new
script**, replace whatever is in the editor with what you copied, and save
(Ctrl+S).

It matches every page but stays dormant except on chat sites it knows.

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

The browser console shows a badge reading `anybridge v1.0 <site>` on an active
site. From there:

- `curl http://localhost:3456/health` — the agent is up and lists its tools
- Ask the chat to list one of your sandbox directories. The agent console prints
  every call it runs, so you can watch it happen.

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
bridge/               the tool layer
  tools.py            13 typed tools: read, write, edit, replace_lines,
                      insert_lines, list, glob, grep, mkdir, move, copy,
                      delete, bash - plus the directory allowlist
  render.py           turns results into the plain text pasted back
  console.py          the agent's terminal output
userscript/           the browser half, including the per-site stream adapters
prompts/sys_prompt.txt what the model is told it can do
docs/SITES.md         per-site protocols, and how to add or re-verify one
tests/                suites, plus fixtures/ holding real captured traffic
probes/               tools for inspecting a live chat's network traffic
```

## Tests

```
python tests/run_all.py            # 107 tests + 5 live captures replayed
python tests/run_all.py --mutate   # also check the tests can actually fail (13 mutations)
python tests/run_all.py --bench    # throughput
```

`--mutate` is worth understanding: it breaks one safety check at a time and
confirms a test notices. Several guards here looked correct but were dead code,
and only mutation testing showed it.

## Safety model

- **Directory allowlist.** File tools are confined to the directories given to
  `agent.py`, defaulting to your home tree plus `C:/temp`. Narrow it per project
  by naming directories on the command line.
- **Read before write.** Modifying a file requires having read the lines being
  changed — not merely having opened the file once. Overwriting a whole file
  requires having read all of it.
- **Delete is strictest.** A file must be known before it is destroyed; a
  non-empty directory needs explicit `"recursive": true`. An allowed root cannot
  be deleted at all.
- **Replay protection.** Each block carries an id and executes once per chat.
- **Reasoning traces are never executed.** Every adapter drops the model's
  private thinking before the payload scan. On some sites reasoning and answer
  share one field, so this is the adapter's main job.
- **The prompt's own example is inert.** The system prompt teaches the format by
  showing a valid tool call, and the DOM scan cannot tell who wrote a code
  block. The script records what it primed a chat with and refuses to act on
  anything that came from it.

**`bash` is not sandboxed.** The allowlist bounds the file tools; a shell
command reaches anything your account can, whatever directories you passed to
`agent.py`. The other twelve tools exist partly so `bash` is rarely needed — but
nothing here contains it. Bounding a shell needs a container, not a path check.

Anything the model reads becomes part of its input, so a file containing
something shaped like an instruction is a prompt-injection vector. The allowlist
limits the blast radius; it does not remove the risk.

The agent binds `127.0.0.1` only. Do not expose the port; anything that can
reach it can run tools as you.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). In short: `python tests/run_all.py` must
be green, new guards need a mutation test that fails without them, and new site
adapters must be built from captured traffic rather than from memory.

## License

MIT — see [LICENSE](LICENSE).
