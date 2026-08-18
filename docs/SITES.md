# Anybridge: supported chat sites

The userscript reads the assistant's answer off the network stream rather than
out of the page. Everything provider-specific lives in the `SITES` table near
the top of `userscript/bridge.user.js`; the rest of the script is shared.

| Site | Hosts | Answer stream | Reasoning filtered by | Verified |
|---|---|---|---|---|
| Qwen | `*.qwen.ai` | `/api/vN/chat/completions` | `delta.phase !== "answer"` | live bytes |
| ChatGPT | `chatgpt.com`, `chat.openai.com` | `/backend-api/conversation` | message `recipient`/`content_type`, plus the `parts/0` path | live bytes |
| Claude | `claude.ai` | `.../completion` | `delta.type !== "text_delta"` | live bytes |
| Kimi | `kimi.com`, `kimi.ai`, `moonshot.cn` | `/apiv2/kimi.gateway.chat.v1.ChatService/Chat` (Connect RPC) | mask must start `block.text` | live bytes |
| Gemini | `gemini.google.com` | `BardFrontendService/StreamGenerate` (XHR, batchexecute) | answer read only from its own field | live bytes |
| DeepSeek | `chat.deepseek.com` | `/api/v0/chat/completion` | current fragment must be typed `RESPONSE`, not `THINK` | live bytes |
| Grok | `grok.com`, `x.ai` | — (not observable from the page) | n/a — DOM scanning only | probed, see below |
| z.ai | `chat.z.ai` | `/api/v2/chat/completions` | `data.phase !== "answer"` | live bytes |

"Unit tests only" means the frame shape was written from memory and the tests
prove the adapter is self-consistent with it — not that it matches what the
provider sends. Capture real bytes for a site with `probes/stream_probe_cdp.js` and
check them with `probes/verify_capture.js` before trusting it.

Capturing real traffic found a serious error in each site that was checked:

- **ChatGPT**: its snapshot frame carries `"p": ""`, an empty string rather than
  an absent key, so a check for `undefined` never matched and the whole
  recipient/content_type gate was dead code. Payloads still fired, so nothing
  looked wrong — the guard simply would not have stopped a tool-call message.
- **Kimi**: not SSE at all. It uses Connect RPC on a completely different URL,
  with length-prefixed binary framing and a `mask`/`op` schema. Every part of
  the guessed adapter was wrong, and it would have silently done nothing.
- **Gemini**: was written off as un-interceptable, but it does stream to the
  page — over **XHR**, in the batchexecute envelope. It gained a real adapter.
- **Grok**: the guessed `urlRe` matched `load-responses`, the conversation
  **history** endpoint, whose body replays every earlier message including
  payloads already executed. It is now DOM-only.
- **DeepSeek**: right URL, wrong everything else. The guessed paths
  (`response/content`, `response/thinking_content`) do not exist. Real deltas go
  to `response/fragments/-1/content` — and reasoning and answer share that one
  path, separated only by the `type` of the most recently created fragment.

Every one of the first six sites checked against live traffic had a real
defect. None were caught by unit tests, because the tests encoded the same
wrong assumption as the code. A seventh, z.ai, was checked the same way and
came back clean on the stream shape - see below - though the check still
found something worth fixing: `MONACO_ACTION`'s selector had been hardcoded to
Qwen's, silently limiting the virtualised-editor recovery path to one site.

## DeepSeek's fragment types

`-1` means "the newest fragment". Both a `THINK` fragment and a `RESPONSE`
fragment stream their text to `response/fragments/-1/content`, so the only thing
distinguishing the model's private reasoning from its answer is which fragment
was created last. An adapter that just matches the path folds the reasoning
trace into the answer and feeds it to the bridge as instructions.

The opening snapshot matters for the same reason: with thinking disabled the
first fragment is the answer and is announced only there, so skipping it loses
both the fragment type and the answer's opening characters.

## Grok: why there is no stream adapter

Grok's generation request could not be observed from the page in any probe.
Hooks on `fetch`, `XMLHttpRequest`, `EventSource` and `WebSocket` — installed
before page scripts via `addInitScript` — saw the surrounding calls but never
the answer, and attaching CDP directly to its shared worker showed nothing
either. A userscript runs in the page, so if the answer never crosses a
page-level transport there is nothing for it to intercept, however the adapter
is written.

Use `probes/transport_probe.js` to re-test; it reports which of the four transports
carried the answer, and refuses to give a verdict if the model did not reply.

`tests/fixtures/capture_chatgpt.txt` and `tests/fixtures/capture_kimi.txt` are kept as regression fixtures.

## Kimi's framing

Connect streaming puts a 5-byte prefix (1 flag byte + 4-byte big-endian length)
before each JSON message, so frames are not newline-separated and a message does
not begin at a line start. Adapters can set `scanJson: true` to have the reader
pull balanced JSON objects out of the byte stream instead of splitting on
newlines.

One trap is worth knowing about: a length byte of `0x7B` is the character `{`,
and in the captured stream one lands directly before a real frame (`{{"op":…`).
Balancing braces from that false start never closes, which the reader reads as
"still streaming" — stalling the stream permanently. Frame starts are therefore
required to look like `{"`, an object opening with a string key.

Reasoning traces are dropped at the adapter, before any payload scan. A model's
private thinking is never treated as an instruction to the bridge.

## z.ai's stream, and its CodeMirror editor

Verified live 2026-08-18 with a debug Chrome the user logged into by hand,
captured with a one-off script modeled on `probes/stream_probe_cdp.js` (that
script's site list is fixed; a throwaway variant was simplest for one extra
host). The stream turned out to be the simplest of the seven: bare `data:
{...}` events, no patch/delta envelope like ChatGPT's or DeepSeek's. Every
frame has the same shape -

```json
{"type":"chat:completion","data":{"delta_content":"...","phase":"thinking"}}
```

- `phase: "thinking"` is the model's private reasoning trace.
- `phase: "answer"` is `delta_content` actually meant for the user; frames
  concatenate, same as everywhere else that streams deltas.
- `phase: "done"` (with `"done": true`) ends the stream; `phase: "other"`
  carries token-usage accounting, not text.

It renders code blocks in CodeMirror, which virtualises exactly like Qwen's
Monaco does - long payloads would be truncated in the DOM. `MONACO_ACTION` used
to be a single hardcoded selector shared by all sites, so it only ever worked
for Qwen; it is now `site.monaco` per adapter. z.ai's copy button
(`.copy-code-button`) was measured the same way Qwen's was: intercept
`navigator.clipboard.writeText` rather than read the real clipboard, click the
button, and check it received the full model text rather than the DOM's
(possibly truncated) one. It did.

## Finding the payload in an answer

Payloads are located by searching for the `"calls": [` marker and walking back to
the object that encloses it — not by trying to brace-balance from every `{`.

The difference is correctness, not just speed. Balancing from every brace needs a
cap to stay affordable, and any cap silently drops real payloads: prose about
sets, templates or LaTeX easily contains thousands of unclosed braces before the
code block, and the scan gives up before reaching it. Anchoring on the marker
has no such limit, and a 280KB response is handled in ~6ms.

## Adopting a site that is not listed

Press **Ctrl+Shift+B** on the chat page and reload. The host is stored in
`bridge_hosts` and handled by the `generic` adapter, which matches any
chat/completion/stream URL and pulls content out of the common delta shapes
(`choices[0].delta.content`, `text`, `token`, `content`, `v`). Press it again to
remove the host.

The generic adapter is a best effort. If a site does not work with it, add a
proper entry to `SITES` — `host`, `urlRe` and a `frame(st, obj)` that appends to
`st.text`. Set `urlRe: null` to skip stream interception entirely and rely on
DOM scanning, as Gemini does. Add an `answer` selector too if you can measure
one (see below); an adopted host has none, so on one the DOM scan still sees
every code block on the page, including your own. Do not adopt a site you do
not trust.

On any host that is neither listed nor adopted the script does nothing at all —
no hooks, no scanning, no logging. It matches `*://*/*` only so Ctrl+Shift+B is
available everywhere.

## Whose message is it? (`answer`)

The DOM scan reads the document, and the document holds your own messages too.
A code block being on the page never meant the model wrote it, so an adapter may
name the container the assistant's messages live in:

| Site | `answer` | The user's turn, for contrast | Verified |
|---|---|---|---|
| ChatGPT | `[data-message-author-role="assistant"]`, `[data-turn="assistant"]` | the same two attributes with `"user"` | live DOM, 2026-08-08 |
| Claude | `.font-claude-response`, `[data-is-streaming]` | `[data-testid="user-message"]`, `[data-cds="UserMessage"]` | live DOM, 2026-08-08 |
| Gemini | `model-response`, `.model-response-text`, `.presented-response-container` | `.user-query-container`, `<user-query-content>` | live DOM, 2026-08-08 |
| Kimi | `.segment-assistant`, `.chat-content-item-assistant` | `.segment-user`, `.chat-content-item-user` | live DOM, 2026-08-08 |
| DeepSeek | `.ds-assistant-message-main-content` | `.ds-message` only — no user-specific class | live DOM, 2026-08-08 |
| Qwen | `.qwen-chat-message-assistant`, `.response-message-content` | `.qwen-chat-message-user`, `.chat-user-message` | live DOM, 2026-08-08 |
| Grok | `[data-testid="assistant-message"]` | `[data-testid="user-message"]` | live DOM, 2026-08-08 |
| z.ai | `.chat-assistant` | `.chat-user` | live DOM, 2026-08-18 |

Grok is the one that matters most: it has no usable stream, so DOM scanning is
its only path rather than a fallback.

Note what the user column is for. It is **contrast, not the mechanism** — the
`answer` selector alone excludes the user's turn on all seven, which was checked
directly rather than assumed. Only ChatGPT's and Claude's markers ended up in
`NOT_THE_MODEL`, since that list exists for hosts with no adapter at all.

Where an adapter names one, nothing outside it is considered — default-deny, so
a site redesign stops the DOM path rather than quietly widening it. Everywhere
else a small subtractive list (`NOT_THE_MODEL` in the userscript) skips blocks
sitting inside markers that several products share for the user's own turn.

**Measure it, do not guess it.** The procedure that produced the row above: open
a chat, send one message containing a fenced code block, ask for a reply
containing one, then walk both blocks' ancestors and find what the two chains do
NOT share. A guessed selector that matches nothing silently stops the bridge
working on that site, and one that matches too much silently re-opens the hole.

## Claude declines the bridge

Claude on claude.ai will not act as the bridge's model. Not a phrasing problem
and not a paste problem - it reads the setup and says no, twice, for reasons it
states clearly:

> I don't have a way to verify what actually happens on your machine... even if
> something comes back, I still can't verify it's a faithful, unmediated report
> of a real file operation versus fabricated text designed to look like one.

> It's asking me to adopt a whole new operating mode (parsing JSON blocks,
> treating fenced code as an action channel) via an in-chat message, which is
> itself the pattern I'd want to be wary of.

A second prompt was written for it - `prompts/sys_prompt.claude.txt`, honest
about the mechanism, keeping its judgment intact, inviting it to test the loop
rather than assert anything. It declined that too, and noted that pre-answering
its objections made it *more* suspicious, which is fair.

That position is coherent, so the answer is not to keep rewording the prompt
until it stops noticing. **Use Anthropic's own tooling for local file work with
Claude** - Claude Code, or an MCP filesystem server - where a tool call is a
real tool call rather than a convention layered over chat text. The bridge is
for the other sites that do accept it.

The per-site prompt mechanism it prompted is still here and still useful:
`GET /prompt?site=<name>` serves `prompts/sys_prompt.<name>.txt` when that file
exists, and the shared prompt otherwise.

## Pasting into the composer

Past a certain size these sites stop treating a paste as a message and turn it
into a file attachment. The system prompt is ~13,000 characters and a rendered
result can reach 30,000, so both were arriving as attachments rather than as
text - the prompt still "worked", quietly, as a document the model may or may
not read closely.

| Site | A single paste becomes a file at | Measured |
|---|---|---|
| ChatGPT | exactly 10,000 characters | 2026-08-09 |
| Claude | ~3,000 for prose of this shape (a single long line survives to ~5,000) | 2026-08-09 |

The script therefore pastes in pieces of `PASTE_CHUNK` characters, split on line
boundaries, with a short pause between them - these editors process a paste
asynchronously and firing the next into the same tick drops pieces. Both sites
were then checked with the real prompt: it stays inline, and every marker in it
survives.

Fidelity is not the price. A single 9,000-character paste into ChatGPT loses
exactly the same leading indentation as the same text in pieces, because its
editor normalises pasted plain text either way.

## Sending a local image (Qwen)

`read_image` is the one tool whose result is not text. Text goes back into the
chat as a paste; an image cannot travel that way, because a chat reads pixels
only from an upload. So the userscript puts a real `File` into the site's own
upload code, on the same message it pastes the results into.

The wiring, end to end:

1. `read_image` returns a description - format, dimensions, size - and no bytes.
2. The userscript fetches the bytes from `GET /image?path=...`, which re-checks
   the allowlist and the file's signature.
3. It pastes them as a `File` into the composer and **waits for the site to show
   the attachment**.
4. Then the results text is pasted and the message sent, carrying both.

An adapter opts in with an `attach.thumb` selector it has measured. Without one
the userscript fetches nothing and appends a line saying the picture is not in
the message - default-deny, because a guessed selector means sending before the
upload lands, which loses the image with no error anywhere.

Note what this does: it uploads the file to the provider. Anything you point
`read_image` at leaves your machine and is stored by them, exactly as if you had
attached it by hand.

**A synthetic `paste` carrying a File is enough on Qwen**: the site
uploads it and renders a thumbnail, exactly as for a real Ctrl+V. That is the
same event `setComposerText` already uses for text, so no new privilege and no
site-specific button driving is needed. Measured with `probes/image_probe_cdp.js`
on 2026-08-15, against a 761-byte PNG:

| Path | Attaches | Notes |
|---|---|---|
| `paste` with a File | yes | one upload; the composer is a `<textarea>` and the handler is document-level |
| `drop` with a File | yes | but only to ONE element - dispatching up the ancestor chain had five levels each handle it, and the same file uploaded five times |
| `#filesUpload.files` + `change` | **no** | nothing happens, even though that hidden input is what the site's own picker fills. A *trusted* set over CDP does nothing either, so this is not about `isTrusted` |
| patch `HTMLInputElement.click`, drive `+ -> Upload attachment` | yes | works, but has more moving parts and the menu labels are localised |

The upload is Alibaba OSS: `POST /api/v2/files/getstsToken`, then a `PUT` of the
file to `qwen-webui-prod.oss-accelerate.aliyuncs.com`. The answer request then
carries it beside the text, which is what proves the model is given the image
rather than the file merely being stored:

```json
"files": [{"type": "image", "id": "a9c5cd4d-...", "url": "https://qwen-webui-prod.oss-accelerate.aliyuncs.com/<user>/<id>_name.png"}]
```

Asked to name the colour filling the image, `qwen3.8-max` answered correctly.

**The timing is the trap.** The `PUT` completed 1.8s after the paste, but the
thumbnail appeared only at **~14s**. `pasteResult` clicks send 500ms after
pasting, which would send the message with no image attached and no error
anywhere. Whatever sends an image must poll for
`.file-card-list img.vision-item-image` whose `alt` is the file name, not wait a
fixed delay.

Two things about the probe are worth keeping if it is ever rewritten, because
each cost a wasted run:

- **Wait for the composer.** On a half-initialised page the attach control
  renders disabled (`opacity:0.4;cursor:not-allowed`) and *every* path fails for
  that reason alone. The first run concluded "no synthetic event attaches a
  file", which was simply wrong.
- **Reload between paths.** Run back to back they contaminate each other: an
  upload started by one lands during the next and is credited to it.

## Fallbacks

- **DOM scanning** runs when there is no stream adapter, or when the stream
  yields no payload. It is subject to virtualised code blocks (Qwen's Monaco
  editor keeps ~30 lines in the DOM), which is why the stream is preferred.
  It only considers blocks that pass the authorship test above.
- **XHR** is hooked alongside `fetch` for sites that stream over
  `XMLHttpRequest`.
- **Composer injection** tries a site-specific selector, then a synthetic paste
  event (what ProseMirror editors like ChatGPT's and Claude's actually handle),
  then `execCommand('insertText')`.
