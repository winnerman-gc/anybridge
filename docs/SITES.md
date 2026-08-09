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

Every one of the six sites checked against live traffic had a real defect. None
were caught by unit tests, because the tests encoded the same wrong assumption
as the code.

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
