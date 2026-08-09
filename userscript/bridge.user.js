// ==UserScript==
// @name         Anybridge
// @namespace    http://tampermonkey.net/
// @version      1.1
// @description  Local tools for any AI chat: typed tool calls read straight from the response stream
// @match        *://*/*
// @noframes
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_listValues
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @connect      localhost
// ==/UserScript==

(function() {
    'use strict';

    const VERSION      = '1.1';   // keep in step with @version above

    // ── Tunables ────────────────────────────────────────────
    const DEBUG        = false;   // per-block logging; costly on large blocks
    const AGENT_URL    = "http://localhost:3456";
    // The agent refuses anything without X-Anybridge. That header is what a web
    // page cannot send: setting it makes the request non-simple, so the browser
    // demands a preflight first, and the agent refuses every preflight. This
    // script is exempt because GM_xmlhttpRequest is privileged and does not
    // preflight - which is exactly why the tools are reachable from here and
    // from nowhere else in the browser.
    const AGENT_HEADERS = { "Content-Type": "application/json", "X-Anybridge": "1" };

    // The header above stops web pages; it cannot tell one LOCAL program from
    // another, since anything running as you can send it too. So the agent
    // mints a token per run and gives it out once, to the first caller that
    // asks - and this script asks by itself, on its first call and again
    // whenever its stored token stops working (which is what an agent restart
    // looks like from here). Nothing to paste, and no long-lived secret: a new
    // agent run means a new token.
    //
    // If something else takes the pairing first, /pair answers 409 and the
    // bridge stops rather than carrying on unprotected. That is deliberate -
    // the failure is visible, and restarting the agent re-pairs.
    const TOKEN_KEY = 'bridge_token';

    const TICK_MS      = 1500;    // scan cadence (only does work when DOM changed)
    const MAX_BLOCKS   = 15;      // newest N leaf code blocks considered
    const MIN_LEN      = 20;      // below this a block cannot hold a payload
    const MAX_LEN      = 200000;  // above this it is not one of ours
    const MAX_KEYS     = 300;     // executed-id records retained per browser
    const MAX_PRIMERS  = 20;      // primed-chat records retained (see primerKey)

    // Elements that may contain a payload. Kept deliberately narrow: attribute
    // substring selectors like [class*="code"] cannot use any index, and the
    // wrappers they match get discarded by the leaf test anyway.
    const BASE_SELECTOR = 'pre, code, [data-language], .hljs';
    // Cheap leaf test - a block containing another block is a wrapper.
    const LEAF_SELECTOR = 'pre, code';

    // A payload must mention calls/commands followed by an array.
    const PAYLOAD_RE = /["'](?:calls|commands)["']\s*:\s*\[/;
    // Results we pasted back in previously - never re-execute those.
    //
    // The BRIDGE RESULT sentinel is safety-critical, not cosmetic. Rendered
    // results contain raw file content, and a file may legitimately contain
    // something shaped exactly like a tool call (this project's own
    // sys_prompt.txt does). If this fails to match, the scanner would execute
    // example commands out of a file that was merely read.
    const RESULT_RE  = /=== BRIDGE RESULT|=== END BRIDGE RESULT|"results"\s*:|"stdout"|"total_lines"|"ok"\s*:/;

    const SELF_FINGERPRINT = '@name         Anybridge';

    const log = (...a) => { if (DEBUG) console.log(...a); };

    // location.hostname is missing in the headless test harness, and some
    // sandboxes hand us a partial location. Derive it from href when absent.
    function hostname() {
        if (typeof location !== 'undefined' && location.hostname) return location.hostname;
        const m = String((typeof location !== 'undefined' && location.href) || '')
            .match(/^[a-z]+:\/\/([^/:]+)/i);
        return m ? m[1] : '';
    }

    // ════════════════════════════════════════════════════════
    // SITE ADAPTERS
    // ════════════════════════════════════════════════════════
    //
    // Everything provider-specific lives here. An adapter says:
    //   host     which hostnames it claims (null = only via generic fallback)
    //   urlRe    which request URL carries the assistant's answer stream
    //            (null = no usable stream, fall back to DOM scanning)
    //   frame    fold one decoded stream frame into the accumulating answer
    //   monaco   the site renders code blocks in a virtualising editor, so the
    //            DOM fallback must go through the block's copy action
    //   input    CSS selector for the composer (optional; generic scan otherwise)
    //   send     CSS selector for the send button (optional)
    //   answer   the container the ASSISTANT's messages render into. The DOM
    //            scan considers nothing outside it, because a code block being
    //            on the page never meant the model wrote it - your own messages
    //            are on the page too. Every one below was measured in a live
    //            session (see docs/SITES.md), not guessed: a probe conversation
    //            with a code block from each side, then diff the two ancestries.
    //
    // `frame` receives a state object it mutates: st.text is the answer so far,
    // st.done marks an explicit end-of-stream. Anything else on st is adapter
    // scratch space.

    // Several providers stream JSON-Patch-ish deltas rather than plain text:
    // {"p":"/message/content/parts/0","o":"append","v":"Hi"} followed by bare
    // {"v":" there"} that inherits the previous path. Shared implementation so
    // ChatGPT and DeepSeek do not each grow their own copy.
    // `apply(st, path, op, v)` receives each resolved write. Sites differ in more
    // than which path holds the answer - DeepSeek has to react to a second path
    // to know whether the current fragment is reasoning or answer - so the
    // shared part is path resolution and inheritance, not the writing.
    function patchAt(st, p, o, v, apply, base) {
        const op = String(o == null ? '' : o).toLowerCase();
        const hasPath = p !== undefined && p !== null && p !== '';
        const path = !hasPath
            ? (base || st.lastPath || '')
            : (base ? base.replace(/\/+$/, '') + '/' + String(p).replace(/^\/+/, '') : String(p));

        // A batch/patch frame carries children whose paths are relative to it.
        if ((op === 'patch' || op === 'batch') && Array.isArray(v)) {
            const childBase = hasPath ? path : '';
            v.forEach(x => patchAt(st, x && x.p, x && x.o, x && x.v, apply, childBase));
            return;
        }
        if (hasPath) st.lastPath = path;
        apply(st, path, op, v);
    }

    function cgApply(st, path, op, v) {
        if (typeof v !== 'string') return;
        if (st.active === false) return;          // wrong message (reasoning, tool call)
        if (!/\/message\/content\/parts\/0$/.test(path)) return;
        if (op === 'replace') st.text = v; else st.text += v;
    }

    // DeepSeek streams a list of "fragments". A fragment is typed THINK or
    // RESPONSE, and BOTH stream their text to the very same path
    // (response/fragments/-1/content) - the -1 meaning "the newest fragment".
    // So the only thing separating the reasoning trace from the answer is which
    // fragment was most recently created. Miss that and the model's private
    // thinking is fed to the bridge as instructions.
    function dsFragments(st, arr) {
        for (const fr of arr) {
            if (!fr || typeof fr !== 'object') continue;
            st.dsType = fr.type;
            if (st.dsType === 'RESPONSE' && typeof fr.content === 'string') st.text += fr.content;
        }
    }

    function dsApply(st, path, op, v) {
        if (path === 'response/fragments' && Array.isArray(v)) { dsFragments(st, v); return; }
        if (path === 'response/status' && v === 'FINISHED') { st.done = true; return; }
        if (path !== 'response/fragments/-1/content' || typeof v !== 'string') return;
        if (st.dsType !== 'RESPONSE') return;
        if (op === 'set') st.text = v; else st.text += v;
    }

    // ChatGPT sends whole-message snapshots as well as deltas. A snapshot both
    // resets the text and decides whether the deltas that follow belong to the
    // visible answer at all - reasoning traces and python tool calls arrive on
    // the same stream and must never be read as instructions.
    function cgAbsorb(st, m) {
        if (!m || typeof m !== 'object') return;
        const role = m.author && m.author.role;
        const type = m.content && m.content.content_type;
        const to   = m.recipient;
        st.active = role === 'assistant' && type === 'text' && (to === undefined || to === 'all');
        st.lastPath = '/message/content/parts/0';
        if (!st.active) return;
        const parts = m.content && m.content.parts;
        if (!Array.isArray(parts)) return;
        const t = parts.filter(x => typeof x === 'string').join('');
        if (t) st.text = t;                        // snapshot is absolute, not a delta
    }

    // Last-resort extractor for a provider we have no adapter for. Walks the
    // frame looking for the first string that plausibly is a content delta.
    // Loose by design; the payload regex downstream is what keeps it honest.
    const SCAVENGE_KEYS = ['delta', 'text', 'token', 'content', 'completion', 'response', 'message'];
    function scavenge(st, o, depth) {
        if (!o || typeof o !== 'object' || (depth || 0) > 6) return;
        const c = o.choices && o.choices[0];
        const d = c && (c.delta || c.message);
        if (d) {
            if (d.phase && d.phase !== 'answer') return;
            if (typeof d.content === 'string') { st.text += d.content; return; }
        }
        for (const k of SCAVENGE_KEYS) {
            const v = o[k];
            if (typeof v === 'string') { if (v) st.text += v; return; }
            if (v && typeof v === 'object') {
                const before = st.text;
                scavenge(st, v, (depth || 0) + 1);
                if (st.text !== before) return;
            }
        }
    }

    const SITES = [
        {
            // Qwen - the original target. Monaco-rendered code blocks.
            name: 'qwen',
            host: /(^|\.)qwen\.ai$/,
            urlRe: /\/api\/v\d+\/chat\/completions/,
            monaco: true,
            answer: '.qwen-chat-message-assistant, .response-message-content',
            frame(st, o) {
                const d = o.choices && o.choices[0] && o.choices[0].delta;
                if (!d) return;
                if (d.phase && d.phase !== 'answer') return;   // reasoning phase
                if (typeof d.content === 'string') st.text += d.content;
                if (d.status === 'finished') st.done = true;
            }
        },
        {
            name: 'chatgpt',
            host: /(^|\.)(chatgpt\.com|chat\.openai\.com)$/,
            urlRe: /\/backend-api\/(f\/)?conversation(\/|\?|$)/,
            input: '#prompt-textarea',
            send: '[data-testid="send-button"], button[aria-label*="Send" i]',
            answer: '[data-message-author-role="assistant"], [data-turn="assistant"]',
            frame(st, o) {
                if (!o) return;
                if (o.message) { cgAbsorb(st, o.message); return; }
                // Initial snapshot, measured live:
                //   {"p":"","o":"add","v":{"message":{...}}}
                // Note p is the EMPTY STRING, not absent. Testing for undefined
                // alone let this frame fall through to patchAt, which discards
                // it as a non-string value - so the recipient/content_type gate
                // below never ran and st.active stayed undefined. Payloads
                // still fired, which is exactly why it went unnoticed.
                if ((o.p === undefined || o.p === '') && o.v && typeof o.v === 'object'
                    && !Array.isArray(o.v) && o.v.message) {
                    cgAbsorb(st, o.v.message);
                    return;
                }
                patchAt(st, o.p, o.o, o.v, cgApply, '');
            }
        },
        {
            name: 'claude',
            host: /(^|\.)claude\.ai$/,
            urlRe: /\/(retry_)?completion(\?|$)/,
            input: 'div[contenteditable="true"]',
            send: '[aria-label="Send message"], button[aria-label*="Send" i]',
            // Measured in a live session, not guessed: a probe conversation was
            // given a code block by the user and a code block by the model, and
            // the two ancestries share nothing. The user's block sits under
            // [data-testid="user-message"] / [data-cds="UserMessage"]; the
            // model's under .font-claude-response and [data-is-streaming].
            answer: '.font-claude-response, [data-is-streaming]',
            frame(st, o) {
                if (!o) return;
                if (o.type === 'content_block_delta' && o.delta) {
                    // thinking_delta is the reasoning trace - never an instruction.
                    if (o.delta.type === 'text_delta' && typeof o.delta.text === 'string')
                        st.text += o.delta.text;
                    return;
                }
                if (o.type === 'message_stop') { st.done = true; return; }
                if (typeof o.completion === 'string') st.text += o.completion;   // legacy shape
            }
        },
        {
            name: 'kimi',
            host: /(^|\.)(kimi\.com|kimi\.ai|moonshot\.cn)$/,
            // Connect RPC (application/connect+json), NOT server-sent events -
            // measured live. Frames are length-prefixed binary, so the newline
            // splitting every other adapter relies on does not apply here;
            // scanJson pulls balanced JSON objects straight out of the bytes.
            urlRe: /\/apiv2\/kimi\.gateway\.chat\.v\d+\.ChatService\/Chat|\/(api|apiv2)\/chat\/.*(completion|stream)/,
            scanJson: true,
            answer: '.segment-assistant, .chat-content-item-assistant',
            frame(st, o) {
                if (!o || typeof o.mask !== 'string') return;
                if (o.mask === 'message.status') {
                    const s = o.message && o.message.status;
                    if (typeof s === 'string' && /COMPLETED|FAILED/.test(s)) st.done = true;
                    return;
                }
                // Only block.text.* is the answer. block.think.* is the reasoning
                // trace, and the "message" / "chat.lastRequest" masks echo the
                // USER's own prompt back - which on this bridge routinely
                // contains a tool-call payload. Matching the mask prefix exactly
                // is what stops the harness executing its own pasted input.
                if (!o.mask.startsWith('block.text')) return;
                const c = o.block && o.block.text && o.block.text.content;
                // Both "set block.text" (the seed) and "append block.text.content"
                // carry a piece of the answer; concatenating every one of them
                // reproduces the response exactly, as verified against a capture.
                if (typeof c === 'string') st.text += c;
            }
        },
        {
            // SSE, but a JSON-Patch-style protocol rather than text deltas, and
            // measured live: paths are response/fragments/-1/content, never the
            // response/content this adapter previously guessed at.
            name: 'deepseek',
            host: /(^|\.)deepseek\.com$/,
            urlRe: /\/api\/v\d+\/chat\/completion/,
            answer: '.ds-assistant-message-main-content',
            frame(st, o) {
                if (!o) return;
                // Opening snapshot: {"v":{"response":{...,"fragments":[...]}}}.
                // It establishes which fragment type is current before any
                // delta arrives, so skipping it means the first fragment's type
                // is unknown and its text is misfiled.
                if ((o.p === undefined || o.p === '') && o.v && o.v.response
                    && Array.isArray(o.v.response.fragments)) {
                    dsFragments(st, o.v.response.fragments);
                    return;
                }
                patchAt(st, o.p, o.o, o.v, dsApply, '');
            }
        },
        {
            // DOM scanning only, deliberately.
            //
            // Grok's generation request was not observable from the page in any
            // probe: hooks on fetch, XMLHttpRequest, EventSource and WebSocket
            // all saw the surrounding calls but never the answer, and attaching
            // CDP to its shared worker showed nothing either. A userscript runs
            // in the page, so if the answer never crosses a page-level
            // transport there is nothing to intercept.
            //
            // The previous guess here matched /rest/app-chat/conversations/,
            // which is worse than useless: that pattern matches load-responses,
            // the CONVERSATION HISTORY endpoint, whose body contains every
            // earlier message - including payloads this bridge already ran and
            // prompts the user typed. Parsing it risks re-executing history.
            name: 'grok',
            host: /(^|\.)(grok\.com|x\.ai)$/,
            urlRe: null,
            answer: '[data-testid="assistant-message"]',
            frame() {}
        },
        {
            // Gemini answers over XHR, not fetch, in Google's batchexecute
            // envelope: a ")]}'" guard, then alternating length / JSON-array
            // lines. Each array line starts with '[', so the ordinary newline
            // framing already handles it - only the payload dig is bespoke.
            name: 'gemini',
            host: /(^|\.)gemini\.google\.com$/,
            urlRe: /BardFrontendService\/StreamGenerate/,
            answer: 'model-response, .model-response-text, .presented-response-container',
            frame(st, o) {
                if (!Array.isArray(o)) return;
                for (const entry of o) {
                    if (!Array.isArray(entry) || entry[0] !== 'wrb.fr') continue;
                    const s = entry[2];
                    if (typeof s !== 'string') continue;
                    let inner;
                    try { inner = JSON.parse(s); } catch { continue; }
                    // Measured position of the answer text. Each chunk carries a
                    // FULL snapshot rather than a delta, so assign, never append.
                    const txt = inner && inner[4] && inner[4][0] && inner[4][0][1] && inner[4][0][1][0];
                    if (typeof txt === 'string' && txt) st.text = txt;
                }
            }
        },
        {
            // Claimed only by hosts the user has explicitly enabled.
            name: 'generic',
            host: null,
            urlRe: /(chat|conversation|completion|message|generate|stream)/i,
            frame(st, o) { scavenge(st, o, 0); }
        }
    ];

    const GENERIC = SITES.find(s => s.name === 'generic');

    function enabledHosts() {
        const v = GM_getValue('bridge_hosts', []);
        return Array.isArray(v) ? v : [];
    }

    function resolveSite() {
        const h = hostname();
        for (const s of SITES) if (s.host && s.host.test(h)) return s;
        if (enabledHosts().indexOf(h) !== -1) return GENERIC;
        return null;
    }

    function toggleHost() {
        const h = hostname();
        const list = enabledHosts();
        const i = list.indexOf(h);
        if (i === -1) { list.push(h); console.log(`✅ AI Bridge enabled on ${h} - reload the page.`); }
        else { list.splice(i, 1); console.log(`🚫 AI Bridge disabled on ${h} - reload the page.`); }
        GM_setValue('bridge_hosts', list);
    }

    const site = resolveSite();

    // Ctrl+Shift+B is registered everywhere so an unknown chat can be adopted
    // without editing the script. Everything else stays dormant off-site.
    if (typeof document !== 'undefined' && document.addEventListener) {
        document.addEventListener('keydown', e => {
            if (e.ctrlKey && e.shiftKey && (e.key === 'B' || e.key === 'b')) {
                e.preventDefault();
                toggleHost();
            }
        });
    }

    if (!site) {
        // Deliberately quiet: this script matches every page.
        log(`AI Bridge dormant on ${hostname()} - Ctrl+Shift+B to enable.`);
        return;
    }

    console.log(`%c anybridge %c v${VERSION} %c ${site.name} `,
        'background:#0aa;color:#000;font-weight:bold',
        'background:#333;color:#fff',
        'background:#555;color:#0ff');

    // The Tampermonkey menu is the only chrome this script has. Registered only
    // on an active site: priming a chat nothing would ever read is a trap.
    if (typeof GM_registerMenuCommand === 'function') {
        GM_registerMenuCommand('Prime this chat with the system prompt', primeChat);
    }

    let isProcessing = false;
    let lastUrl = location.href;
    let dirty = true;        // DOM changed since last scan -> scan is worthwhile
    let recheck = false;     // a block was mid-stream -> force next tick

    // Text of each block at the previous scan. WeakMap so detached chat nodes
    // are collected normally. A block must read identical twice before it runs,
    // which is what stops half-streamed JSON from executing.
    const lastText = new WeakMap();
    // Blocks conclusively rejected at their current length; skipped until they grow.
    const settledAt = new WeakMap();
    // Consecutive scans where a block looked like a payload but never balanced.
    const incomplete = new WeakMap();
    const STUCK_AFTER = 5;   // ~7.5s at TICK_MS before we call it stuck

    function getChatId() {
        const match = location.href.match(/\/(?:chat|c|conversation|thread)\/([a-zA-Z0-9_-]+)/);
        if (match) return match[1];
        return location.pathname
            ? location.pathname.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 50)
            : hostname();
    }

    // The system prompt shows the model an EXAMPLE payload, so the moment it is
    // in the page it looks exactly like a tool call - and the DOM scan reads
    // every code block, including the user's own messages. Left alone it would
    // execute the example and burn its id, silently skipping the model's first
    // real block. So remember what was injected and refuse to act on anything
    // that is part of it. Whitespace is squashed because the composer, the
    // renderer and the DOM each reflow it differently.
    //
    // Deliberately NOT under the `bridge_` prefix: these are provenance, not
    // execution records, and Ctrl+Shift+R wipes that prefix to force a re-run.
    // A re-run must not be able to resurrect the example payload.
    const squash = s => s.replace(/\s+/g, '');

    function primerKey() { return `bridgeprime_${getChatId()}`; }

    function rememberPrimer(text) {
        GM_setValue(primerKey(), `${Date.now()}\n${squash(text)}`);
        prunePrimers();
    }

    function isPrimerText(text) {
        const stored = GM_getValue(primerKey(), '');
        if (!stored) return false;
        const body = stored.slice(stored.indexOf('\n') + 1);
        const needle = squash(text);
        return needle.length > 0 && body.includes(needle);
    }

    // One record per primed chat, a few KB each. pruneKeys() only sweeps the
    // bridge_ prefix, so these need their own cap.
    function prunePrimers() {
        if (typeof GM_listValues !== 'function') return;
        const keys = GM_listValues().filter(k => k.startsWith('bridgeprime_'));
        if (keys.length <= MAX_PRIMERS) return;
        keys.map(k => ({ k, t: parseInt(GM_getValue(k, '0'), 10) || 0 }))
            .sort((a, b) => a.t - b.t)
            .slice(0, keys.length - MAX_PRIMERS)
            .forEach(({ k }) => GM_deleteValue(k));
    }

    // A payload with no "id" used to get one built from the clock, which is
    // unique every time it is generated - so the replay guard could neither
    // recognise it nor usefully record it, and both were skipped for those ids.
    // The effect was that an id-less block re-ran every time its text came back
    // round: a reload, a second scan, the stream path and the DOM path seeing
    // the same answer. Deriving the id from the CALLS instead makes the same
    // request produce the same id, so it dedupes like any other.
    //
    // FNV-1a, because this needs to be stable and cheap, not cryptographic.
    // A payload that only parsed after repair is a guess about what the model
    // meant. The repair rewrites the text outside string literals - strips
    // comments, drops trailing commas, turns True into true - so what runs is
    // not quite what was written. That is a fine trade for a file edit, whose
    // damage is bounded by the allowlist and undone by reading the file back.
    // It is not a fine trade for a shell command, which no allowlist bounds and
    // which cannot be un-run. So a repaired payload may edit; it may not run.
    function dropsShellWhenRepaired(calls, repaired, where) {
        if (!repaired) return calls;
        const clean = calls.filter(c => !c || c.tool !== 'bash');
        if (clean.length !== calls.length) {
            console.log(`🚫 ${where} Refusing a bash call from a payload that only `
                + `parsed after repair - re-send it as valid JSON`);
        }
        return clean;
    }

    function contentId(calls) {
        const s = JSON.stringify(calls);
        let h = 0x811c9dc5;
        for (let i = 0; i < s.length; i++) {
            h ^= s.charCodeAt(i);
            h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
        }
        return `auto_h${h.toString(16)}_${s.length}`;
    }

    function hasBeenExecuted(commandId) {
        return GM_getValue(`bridge_${getChatId()}_${commandId}`, false);
    }

    function markAsExecuted(commandId) {
        GM_setValue(`bridge_${getChatId()}_${commandId}`, Date.now());
    }

    // Execution records accumulated forever in v4. Drop the oldest past a cap.
    function pruneKeys() {
        if (typeof GM_listValues !== 'function') return;
        const keys = GM_listValues().filter(k => k.startsWith('bridge_'));
        if (keys.length <= MAX_KEYS) return;
        keys.map(k => ({ k, t: GM_getValue(k, 0) }))
            .sort((a, b) => a.t - b.t)
            .slice(0, keys.length - MAX_KEYS)
            .forEach(({ k }) => GM_deleteValue(k));
        log(`🗑️ Pruned ${keys.length - MAX_KEYS} old execution keys`);
    }

    // Parse a payload, repairing it only if it is actually broken.
    //
    // Every repair below is a heuristic that can corrupt legitimate file content,
    // so the overwhelmingly common case - the model emitted valid JSON - must
    // never reach them. Try a clean parse first; only damaged payloads pay the
    // risk of being "fixed".
    function parsePayload(jsonStr) {
        const s = normalizeTransport(jsonStr);
        try { return { ok: true, value: JSON.parse(s) }; } catch {}
        try { return { ok: true, value: JSON.parse(sanitizeJsonString(s)), repaired: true }; }
        catch (e) { return { ok: false, error: e, sanitized: sanitizeJsonString(s) }; }
    }

    // Qwen renders code blocks in a Monaco editor, which emits every space as a
    // non-breaking space: a 12-line payload came back carrying 51 of them. That
    // is a rendering artifact of the transport, not content, and it must be
    // undone EVERYWHERE - including inside string literals, where it would
    // otherwise be written to disk as the indentation of a source file.
    // (NBSP-indented Python is a SyntaxError.) Applying it only outside strings,
    // or only on the repair path, silently corrupts every file written.
    //
    // The trade: a payload that genuinely wants a literal NBSP in file content
    // cannot express one. Monaco makes that indistinguishable anyway.
    function normalizeTransport(str) {
        return str
            .replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000\uFEFF]/g, ' ')
            .replace(/[\u200B-\u200D]/g, '');
    }

    // Apply fn to the parts of str that lie OUTSIDE string literals, leaving
    // literal content byte-for-byte intact. Without this, "remove // comments"
    // deletes the rest of a payload the moment a file contains a URL, and
    // "True -> true" rewrites English prose being written to disk.
    function mapOutsideStrings(str, fn) {
        let out = '', seg = '', inString = false, escaped = false;
        for (const ch of str) {
            if (inString) {
                seg += ch;
                if (escaped) { escaped = false; }
                else if (ch === '\\') { escaped = true; }
                else if (ch === '"') { out += seg; seg = ''; inString = false; }
                continue;
            }
            if (ch === '"') { out += fn(seg); seg = '"'; inString = true; continue; }
            seg += ch;
        }
        // A trailing unterminated literal is left alone: it is content, not syntax.
        return out + (inString ? seg : fn(seg));
    }

    function sanitizeJsonString(str) {
        // Single quotes have to be handled before anything else, because until
        // they are normalised we cannot tell where the string literals even are.
        if (!/"[a-zA-Z_]+"/.test(str) && /'[a-zA-Z_]+'/.test(str)) {
            str = str.replace(/'/g, '"');
        }

        // NBSP and zero-width characters are handled globally by
        // normalizeTransport before this runs - they are transport damage, not
        // malformed JSON, and must be fixed inside string literals too.
        str = mapOutsideStrings(str, seg => seg
            // Comments
            .replace(/\/\/[^\n]*/g, '')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            // Python-style literals
            .replace(/\bTrue\b/g, 'true')
            .replace(/\bFalse\b/g, 'false')
            .replace(/\bNone\b/g, 'null')
            // Trailing commas before } or ]
            .replace(/,\s*([}\]])/g, '$1')
        );

        // Control characters must be escaped INSIDE string literals and are mere
        // formatting OUTSIDE them. The old blanket replace turned the JSON's own
        // structural newlines into literal \n, so any pretty-printed payload was
        // invalid on every chat UI whose textContent preserves newlines.
        str = escapeControlChars(str);

        return str.trim();
    }

    // Single left-to-right pass that tracks string context and backslash escapes.
    function escapeControlChars(str) {
        let out = '';
        let inString = false;
        let escaped = false;
        for (const ch of str) {
            if (escaped) { out += ch; escaped = false; continue; }
            if (ch === '\\' && inString) { out += ch; escaped = true; continue; }
            if (ch === '"') { inString = !inString; out += ch; continue; }
            if (ch > '\x1F') { out += ch; continue; }
            if (!inString) {
                out += ' ';                       // structural whitespace
            } else if (ch === '\n') { out += '\\n'; }
            else if (ch === '\r') { out += '\\r'; }
            else if (ch === '\t') { out += '\\t'; }
            else { out += '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'); }
        }
        return out;
    }

    // Qwen renders code blocks in a Monaco editor, which VIRTUALISES: only the
    // ~30 visible lines exist in the DOM. Measured on a real 72-line payload,
    // textContent held 1390 chars of a 3553-char block and the JSON never
    // closed - so scraping the DOM means long calls silently never run.
    //
    // The block header's copy action reads Monaco's model rather than the DOM.
    // We intercept the writeText it calls instead of reading the clipboard:
    // no permissions needed, and the user's real clipboard is never touched.
    //
    // Gated on site.monaco. Every other chat renders the full block into the
    // DOM, so clicking their copy buttons would be a side effect for no gain.
    const MONACO_ACTION = '.qwen-markdown-code-header-action-item';

    // The header holds a copy action AND a download action. Taking the first
    // match works today only because copy happens to come first; if that order
    // ever flips we would trigger a file download on every payload. Identify it
    // by its icon and fall back to first-match only if the icon is not found.
    function findCopyButton(el) {
        const items = [...el.querySelectorAll(MONACO_ACTION)];
        const byIcon = items.find(it => {
            const use = it.querySelector('use');
            const href = use && (use.getAttribute('xlink:href') || use.getAttribute('href') || '');
            return /copy/i.test(href || '');
        });
        return byIcon || items[0] || null;
    }

    async function readBlockText(el) {
        const dom = el.textContent || '';
        if (!site.monaco) return dom;
        const btn = findCopyButton(el);
        if (!btn) return dom;                       // ordinary <pre><code>, DOM is fine

        const win = (typeof unsafeWindow !== 'undefined' && unsafeWindow) || window;
        const clip = win.navigator && win.navigator.clipboard;
        if (!clip || !clip.writeText) return dom;

        let captured = null, viaEvent = null;
        const orig = clip.writeText;
        const onCopy = e => {
            try { viaEvent = e.clipboardData && e.clipboardData.getData('text/plain'); } catch {}
        };
        try {
            clip.writeText = function (t) { captured = t; return Promise.resolve(); };
            document.addEventListener('copy', onCopy, true);
            btn.click();
            await new Promise(r => setTimeout(r, 250));
        } catch (e) {
            log('   copy-intercept failed: ' + e.message);
        } finally {
            clip.writeText = orig;                  // always restore, even on throw
            document.removeEventListener('copy', onCopy, true);
        }

        const full = captured || viaEvent;
        if (full && full.length >= dom.length) return full;
        return dom;                                 // never regress on the DOM text
    }

    // Extract the first brace-balanced {...} region, tracking string literals so
    // braces inside content do not count. Returns null when the block has not
    // finished streaming - which is the honest signal to wait, whereas
    // lastIndexOf('}') happily returns a truncated prefix that then fails to
    // parse and logs an alarming error for what is simply a half-rendered block.
    function extractBalancedJson(text, from) {
        const start = text.indexOf('{', from || 0);
        if (start === -1) return null;
        let depth = 0, inString = false, escaped = false;
        for (let i = start; i < text.length; i++) {
            const ch = text[i];
            if (escaped) { escaped = false; continue; }
            if (ch === '\\' && inString) { escaped = true; continue; }
            if (ch === '"') { inString = !inString; continue; }
            if (inString) continue;
            if (ch === '{') depth++;
            else if (ch === '}' && --depth === 0) return text.substring(start, i + 1);
        }
        return null;   // still streaming
    }

    // Newest MAX_BLOCKS leaf blocks, walking backwards so we never touch the
    // whole document when a chat is long.
    //
    // A code block being ON the page never meant the model wrote it. This scan
    // reads the document, and the document holds your own messages, quoted
    // snippets, and anything a page chose to render - all of which used to be
    // executable simply for looking like a payload. Two filters narrow it:
    //
    //   site.answer  the container the assistant's messages live in. Where an
    //                adapter knows it, nothing outside it is even considered.
    //                Default-deny, so a site redesign stops the DOM path rather
    //                than quietly widening it.
    //   NOT_THE_MODEL  a small set of "this is the user's turn" markers that
    //                several products happen to share, for the sites with no
    //                answer selector and for hosts adopted by hand. Purely
    //                subtractive: if it matches nothing, behaviour is as before.
    const NOT_THE_MODEL = '[data-testid="user-message"], [data-cds="UserMessage"],'
        + ' [data-message-author-role="user"], [class*="user-message" i],'
        + ' [class*="human-turn" i]';

    function collectCandidates() {
        const all = document.querySelectorAll(BASE_SELECTOR);
        const out = [];
        for (let i = all.length - 1; i >= 0 && out.length < MAX_BLOCKS; i--) {
            const el = all[i];
            if (el.querySelector(LEAF_SELECTOR)) continue;  // wrapper, not a leaf
            if (!authoredByModel(el)) continue;
            out.push(el);
        }
        return out.reverse();
    }

    function authoredByModel(el) {
        if (!el.closest) return true;              // no closest(): assume as before
        if (el.closest(NOT_THE_MODEL)) {
            log('   ⏭️ [SCAN] Skipping a block in the user\'s own message');
            return false;
        }
        if (site.answer && !el.closest(site.answer)) {
            log('   ⏭️ [SCAN] Skipping a block outside the assistant\'s message');
            return false;
        }
        return true;
    }

    async function extractPayload(el, i) {
        // Cheap screening runs on the DOM text. It is truncated for long Monaco
        // blocks, but the payload marker appears near the top so it still
        // decides correctly whether this block is worth the copy round-trip.
        const text = el.textContent || '';

        if (text.length < MIN_LEN || text.length > MAX_LEN) return null;
        if (settledAt.get(el) === text.length) return null;   // rejected, unchanged
        if (text.includes(SELF_FINGERPRINT)) { settledAt.set(el, text.length); return null; }

        // One cheap regex decides whether this block is worth any real work.
        if (!PAYLOAD_RE.test(text)) { settledAt.set(el, text.length); return null; }
        if (RESULT_RE.test(text))   { settledAt.set(el, text.length); return null; }

        // Only blocks that already look like a payload reach the primer check,
        // so the storage read stays off the hot path.
        if (isPrimerText(text)) {
            log(`   ⏭️ [BLOCK ${i}] Example from the injected system prompt`);
            settledAt.set(el, text.length);
            return null;
        }

        // Stability gate: identical text on two consecutive scans. While a
        // response is still streaming the text keeps changing, and executing a
        // partially rendered block would burn its id on an incomplete payload.
        const prev = lastText.get(el);
        lastText.set(el, text);
        if (prev !== text) {
            log(`   ⏳ [BLOCK ${i}] Still streaming, deferring`);
            recheck = true;
            return null;
        }

        // Only now, once the block has stopped changing, pull the authoritative
        // text out of Monaco. Doing this during streaming would fire the copy
        // action on every tick for no gain.
        const full = await readBlockText(el);

        const rawText = full
            .replace(/^```json\s*/i, '').replace(/```$/gm, '').trim()
            .replace(/^```\s*/i, '').replace(/```$/gm, '').trim();

        const jsonStr = extractBalancedJson(rawText);
        if (jsonStr === null) {
            // Braces still do not balance even with Monaco's full model text,
            // so the response probably has not finished. Wait, quietly - but not
            // forever. A payload that never balances is the silent-hang failure
            // that hid the Monaco truncation bug for so long, so after a few
            // attempts say so loudly instead of retrying in silence.
            const n = (incomplete.get(el) || 0) + 1;
            incomplete.set(el, n);
            if (n === STUCK_AFTER) {
                console.warn(`⚠️ [BLOCK ${i}] JSON never completed after ${n} attempts ` +
                    `(${full.length} chars, DOM had ${text.length}). If these are equal, the ` +
                    `code block is virtualised and long payloads cannot be read from the DOM.`);
            }
            log(`   ⏳ [BLOCK ${i}] Incomplete JSON (${full.length} chars), still streaming`);
            recheck = true;
            return null;
        }
        incomplete.delete(el);

        const parsed = parsePayload(jsonStr);
        if (!parsed.ok) {
            const e = parsed.error;
            // Only noisy on a block that claimed to be a payload - worth seeing.
            console.log(`   ❌ [BLOCK ${i}] JSON parse error: ${e.message}`);
            const posMatch = e.message.match(/position (\d+)/);
            if (posMatch) {
                const pos = parseInt(posMatch[1]);
                const context = parsed.sanitized.substring(Math.max(0, pos - 20), pos + 20);
                console.log(`   🔬 [BLOCK ${i}] Around position ${pos}: "${context}"`);
                console.log(`   🔬 [BLOCK ${i}] Char codes: ` +
                    [...context].map(c => `${c}(${c.charCodeAt(0)})`).join(' '));
            }
            settledAt.set(el, text.length);
            return null;
        }
        if (parsed.repaired) {
            console.log(`   🔧 [BLOCK ${i}] Payload was malformed and repaired - verify the result`);
        }
        const payload = parsed.value;

        // v3 "calls" of tool objects, or legacy v2 "commands" of shell strings.
        let calls = null;
        if (Array.isArray(payload.calls) && payload.calls.length > 0) {
            calls = payload.calls;
        } else if (Array.isArray(payload.commands) && payload.commands.length > 0) {
            calls = payload.commands.map(c => ({ tool: "bash", cmd: c }));
        }
        calls = dropsShellWhenRepaired(calls, parsed.repaired, `[BLOCK ${i}]`);
        if (!calls || !calls.length) { settledAt.set(el, text.length); return null; }

        const commandId = payload.id || contentId(calls);
        if (hasBeenExecuted(commandId)) {
            log(`   ⏭️ [BLOCK ${i}] Already executed: "${commandId}"`);
            settledAt.set(el, text.length);
            return null;
        }

        settledAt.set(el, text.length);   // do not re-parse unless it changes
        return { calls, commandId };
    }

    // A fence must be longer than the longest backtick run it wraps, or file
    // content containing ``` terminates the block early and the rest of the
    // result leaks into prose as chat markdown.
    function fenceFor(body) {
        let longest = 0;
        for (const run of body.match(/`+/g) || []) longest = Math.max(longest, run.length);
        return '`'.repeat(Math.max(3, longest + 1));
    }

    function findComposer() {
        if (site.input) {
            for (const el of document.querySelectorAll(site.input)) {
                const r = el.getBoundingClientRect ? el.getBoundingClientRect() : { width: 1, height: 1 };
                if (r.height > 0 && r.width > 0) return el;
            }
        }
        const inputs = document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]');
        let target = null;
        for (const el of inputs) {
            const r = el.getBoundingClientRect ? el.getBoundingClientRect() : { width: 1, height: 1 };
            if (r.height > 0 && r.width > 0 && !(el.closest && el.closest('pre'))) target = el;
        }
        return target;
    }

    // Past a certain size a paste stops being a message and becomes a file
    // attachment. Measured 2026-08-09: ChatGPT converts any paste of 10,000
    // characters or more, Claude somewhere between 4,000 and 5,000. The system
    // prompt is ~13,000 characters, so priming had quietly turned into "here is
    // an attachment" rather than an instruction - and a rendered result can
    // reach 30,000, which would do the same to tool output.
    //
    // Pasting in pieces keeps it a message. Fidelity is not the cost: a single
    // 9,000-character paste into ChatGPT loses exactly the same leading
    // indentation as the same text in pieces, because its editor normalises
    // pasted plain text either way.
    const PASTE_CHUNK = 2000;      // comfortably under the lowest limit measured

    function pasteChunks(text) {
        const out = [];
        let cur = '';
        for (const line of text.split('\n')) {
            if (cur && cur.length + line.length + 1 > PASTE_CHUNK) { out.push(cur); cur = ''; }
            cur += (cur ? '\n' : '') + line;
        }
        if (cur) out.push(cur);
        // Split on line boundaries so a piece never tears a line in half - each
        // paste lands as its own paragraph. A single line longer than the limit
        // has no boundary to use, so cut it rather than send one oversized paste
        // and lose the whole thing to an attachment.
        const safe = [];
        for (const piece of out) {
            if (piece.length <= PASTE_CHUNK) { safe.push(piece); continue; }
            for (let i = 0; i < piece.length; i += PASTE_CHUNK) {
                safe.push(piece.slice(i, i + PASTE_CHUNK));
            }
        }
        return safe;
    }

    const pause = ms => new Promise(r => setTimeout(r, ms));

    // ChatGPT, Claude and Kimi all compose in ProseMirror-style contenteditables
    // where execCommand('insertText') can flatten or drop newlines. A synthetic
    // paste is the path those editors actually implement, so try it first and
    // only fall back when nothing consumes the event.
    async function setComposerText(target, text) {
        target.focus();

        if (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT') {
            const proto = target.tagName === 'TEXTAREA'
                ? window.HTMLTextAreaElement && window.HTMLTextAreaElement.prototype
                : window.HTMLInputElement && window.HTMLInputElement.prototype;
            const setter = proto && Object.getOwnPropertyDescriptor(proto, 'value')?.set;
            if (setter) setter.call(target, text); else target.value = text;
            target.dispatchEvent(new Event('input', { bubbles: true }));
            return;
        }

        try {
            const pieces = pasteChunks(text);
            let consumed = true;
            for (let i = 0; i < pieces.length && consumed; i++) {
                const dt = new DataTransfer();
                dt.setData('text/plain', pieces[i]);
                const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
                // Only the first piece replaces what is there; the rest append
                // at the caret the previous one left behind.
                if (i === 0) document.execCommand('selectAll', false, null);
                // dispatchEvent returns false when the editor called
                // preventDefault, i.e. when it handled the paste itself.
                consumed = !target.dispatchEvent(ev);
                // These editors process a paste asynchronously; firing the next
                // one into the same tick drops pieces.
                if (consumed && i + 1 < pieces.length) await pause(120);
            }
            if (consumed) return;
        } catch (e) {
            log('   paste-injection unavailable: ' + e.message);
        }

        document.execCommand('selectAll', false, null);
        document.execCommand('insertText', false, text);
        target.dispatchEvent(new Event('input', { bubbles: true }));
    }

    function clickSend(target) {
        if (site.send) {
            for (const b of document.querySelectorAll(site.send)) {
                if (b.disabled) continue;
                b.click();
                console.log("📤 [SUBMIT] Clicked send button");
                return;
            }
        }
        for (const b of document.querySelectorAll('button')) {
            const label = ((b.innerText || '') + " " + (b.getAttribute('aria-label') || "")).toLowerCase();
            if (b.disabled) continue;
            if (label.includes('send') || label.includes('submit')) {
                b.click();
                console.log("📤 [SUBMIT] Clicked send button");
                return;
            }
        }
        target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
        console.log("📤 [SUBMIT] Sent via Enter key");
    }

    async function pasteResult(result) {
        // Prefer the agent's plain-text render: file content reaches the model
        // with real newlines and real indentation, so what it reads back is
        // byte-identical to what is on disk. Fall back to JSON for older agents.
        const body = typeof result.render === 'string' && result.render
            ? result.render
            : JSON.stringify(result, null, 2);
        const fence = fenceFor(body);
        const resultText = fence + "\n" + body + "\n" + fence;

        const target = findComposer();
        if (!target) { console.log("❌ [PASTE] Could not find input box!"); return; }

        console.log("📋 [PASTE] Injecting batch result...");
        await setComposerText(target, resultText);
        setTimeout(() => clickSend(target), 500);
    }

    function agentRequest(opts, allowPairing) {
        const token = GM_getValue(TOKEN_KEY, '');
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest(Object.assign({}, opts, {
                headers: Object.assign({}, AGENT_HEADERS,
                    token ? { 'X-Anybridge-Token': token } : {}),
                onload: async res => {
                    // 403 means the agent does not know this token: either we
                    // have none yet, or it restarted and minted a new one.
                    if (res.status === 403 && allowPairing !== false) {
                        try {
                            await pair();
                        } catch (e) {
                            return reject(e);
                        }
                        return agentRequest(opts, false).then(resolve, reject);
                    }
                    resolve(res);
                },
                onerror: err => reject(err),
                ontimeout: () => reject('Agent timeout')
            }));
        });
    }

    function pair() {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: AGENT_URL + '/pair',
                headers: AGENT_HEADERS,
                timeout: 15000,
                onload: res => {
                    if (res.status === 409) {
                        return reject('another client paired with the agent first - '
                            + 'restart the agent to pair this browser');
                    }
                    let data;
                    try { data = JSON.parse(res.responseText); } catch { data = null; }
                    if (!data || !data.token) return reject('agent refused to pair');
                    GM_setValue(TOKEN_KEY, data.token);
                    console.log('🔑 [PAIR] Paired with the agent');
                    resolve(data.token);
                },
                onerror: () => reject('agent unreachable - is `python agent.py` running?'),
                ontimeout: () => reject('agent timeout while pairing')
            });
        });
    }

    // Fetched from the agent rather than baked in here: prompts/sys_prompt.txt
    // belongs to the agent, so the text describes the tool set that is actually
    // running, and editing it needs no reinstall of this script. It also means
    // priming fails loudly when the agent is down - which is the one case where
    // priming would be pointless anyway.
    async function fetchSysPrompt() {
        const res = await agentRequest({
            method: "GET",
            url: AGENT_URL + "/prompt",
            timeout: 15000
        });
        let data;
        try { data = JSON.parse(res.responseText); }
        catch { throw "invalid JSON from agent: " + res.responseText.substring(0, 200); }
        if (typeof data.prompt === "string" && data.prompt) return data.prompt;
        throw data.error || "agent returned no prompt";
    }

    async function primeChat() {
        let text;
        try {
            text = await fetchSysPrompt();
        } catch (e) {
            console.log("❌ [PRIME] " + e);
            return;
        }

        const target = findComposer();
        if (!target) { console.log("❌ [PRIME] Could not find input box!"); return; }

        // Recorded BEFORE the text lands in the page: the scan tick runs on a
        // timer and the composer fires mutations of its own, so a record written
        // afterwards can lose the race against the block it is meant to protect.
        rememberPrimer(text);

        console.log(`📜 [PRIME] Injecting the system prompt (${text.length} chars)`);
        await setComposerText(target, text);
        setTimeout(() => clickSend(target), 500);
    }

    async function scanAndExecute(force) {
        if (isProcessing) return;
        // Once the stream hook has delivered a payload it is the authoritative
        // source; scraping the DOM as well only risks acting on a truncated
        // view. Dedupe by id would catch it, but not scanning at all is cheaper
        // and removes the failure mode entirely.
        if (streamSeen && !force) return;
        if (!force && !dirty && !recheck) return;   // nothing changed since last scan
        dirty = false;
        recheck = false;

        const blocks = collectCandidates();
        log(`📦 [SCAN] ${blocks.length} leaf blocks`);

        const batched = [];
        for (let i = 0; i < blocks.length; i++) {
            const found = await extractPayload(blocks[i], i);
            if (found) {
                log(`   📥 [BLOCK ${i}] Queued: ${found.calls.length} calls (ID: "${found.commandId}")`);
                batched.push(found);
            }
        }
        if (batched.length === 0) return;
        await runBatch(batched, 'dom');
    }

    // Shared execution path. Both sources - the DOM scanner and the response
    // stream hook - funnel through here, and the id dedupe means whichever sees
    // a payload first wins while the other is skipped harmlessly.
    //
    // Queued, not dropped. The DOM scanner could afford to bail when busy
    // because it rescans every tick. The stream hook sees each response exactly
    // once, so returning early here would lose that payload permanently.
    const batchQueue = [];
    let draining = false;

    async function runBatch(batched, source) {
        batchQueue.push({ batched, source });
        if (draining) return;
        draining = true;
        try {
            while (batchQueue.length) {
                const job = batchQueue.shift();
                await runOneBatch(job.batched, job.source);
                await new Promise(r => setTimeout(r, 1500));   // let the UI settle
            }
        } finally {
            draining = false;
        }
    }

    async function runOneBatch(batched, source) {
        isProcessing = true;

        const mergedCalls = [];
        const mergedIds = [];
        for (const entry of batched) {
            if (entry.commandId && hasBeenExecuted(entry.commandId)) continue;
            mergedCalls.push(...entry.calls);
            mergedIds.push(entry.commandId);
        }
        if (mergedCalls.length === 0) { isProcessing = false; return; }

        console.log(`🚀 [BATCH via ${source}] ${mergedCalls.length} calls from ${mergedIds.length} payload(s)`, mergedCalls);

        try {
            const res = await agentRequest({
                method: "POST",
                url: AGENT_URL,
                data: JSON.stringify({ calls: mergedCalls }),
                timeout: 120000
            });
            let result;
            try { result = JSON.parse(res.responseText); }
            catch { throw "Invalid JSON from agent: " + res.responseText.substring(0, 200); }

            console.log("✅ [BATCH] Agent responded:", result);

            for (const id of mergedIds) {
                if (id) markAsExecuted(id);
            }
            pruneKeys();

            await pasteResult(result);

        } catch (e) {
            console.error("❌ [BATCH] Error:", e);
        } finally {
            setTimeout(() => { isProcessing = false; }, 2000);
        }
    }

    // ── Response stream hook (primary source) ───────────────
    //
    // Reading the model's answer off the wire instead of out of the page fixes
    // by construction everything the DOM scanner has to fight:
    //   - virtualised code blocks (only ~30 lines ever reach the DOM)
    //   - every space arriving as U+00A0
    //   - guessing when streaming has finished (the stream says so explicitly)
    //   - re-reading file content we pasted back in as results
    //   - reasoning traces, which the adapters drop before we ever see them

    // Find every balanced {...} in the answer that looks like a payload.
    //
    // Deliberately NOT fence-based. A ```json fence match is non-greedy, so the
    // moment a payload writes a file that itself contains ``` - any markdown
    // doc, any README - the match stops at that inner fence and cuts the JSON
    // in half. Long writes are exactly the ones likely to contain fences, which
    // is why that bug looks like "big payloads never fire". Brace balancing
    // does not care what the content contains.
    // Anchor on the marker, not on braces.
    //
    // Trying to balance from every '{' in the answer needs a cap to stay cheap,
    // and any cap silently drops real payloads: prose about sets, templates or
    // LaTeX easily contains hundreds of unclosed braces before the code block,
    // and the scan gives up before reaching it. Starting from "calls": [ - of
    // which there are one or two - and walking back to the object that encloses
    // it has no such limit, and does far less work besides.
    const PAYLOAD_MARK = /["'](?:calls|commands)["']\s*:\s*\[/g;
    const MAX_PAYLOADS = 20;
    const MAX_BACKTRACK = 4000;   // how far back the enclosing '{' may sit

    function payloadsFromMarkdown(md) {
        const out = [];
        const seen = new Set();
        const push = jsonStr => {
            if (!jsonStr || seen.has(jsonStr)) return false;
            seen.add(jsonStr);
            const parsed = parsePayload(jsonStr);
            if (!parsed.ok) return false;
            const p = parsed.value;
            let calls = null;
            if (Array.isArray(p.calls) && p.calls.length) calls = p.calls;
            else if (Array.isArray(p.commands) && p.commands.length)
                calls = p.commands.map(c => ({ tool: 'bash', cmd: c }));
            if (!calls) return false;
            if (parsed.repaired) console.log('🔧 [STREAM] Payload was malformed and repaired - verify the result');
            calls = dropsShellWhenRepaired(calls, parsed.repaired, '[STREAM]');
            if (!calls.length) return false;
            out.push({ calls, commandId: p.id || contentId(calls) });
            return true;
        };

        PAYLOAD_MARK.lastIndex = 0;
        let m, seenMarks = 0;
        while ((m = PAYLOAD_MARK.exec(md)) !== null && seenMarks < MAX_PAYLOADS) {
            seenMarks++;
            const limit = Math.max(0, m.index - MAX_BACKTRACK);
            for (let i = m.index; i >= limit; i--) {
                if (md.charCodeAt(i) !== 123) continue;            // '{'
                const jsonStr = extractBalancedJson(md, i);
                // Must actually enclose the marker: a nearer object that closes
                // before it is a different value entirely.
                if (!jsonStr || i + jsonStr.length <= m.index) continue;
                if (push(jsonStr)) {
                    PAYLOAD_MARK.lastIndex = i + jsonStr.length;   // resume past it
                    break;
                }
            }
        }
        return out;
    }

    // Frames are split on single newlines rather than the SSE blank-line
    // separator. Every provider here puts one complete JSON object on one
    // "data:" line, and content newlines are \n-escaped inside that JSON, so
    // this also handles the NDJSON providers (Grok) with no special casing.
    function makeStreamState() {
        return { text: '', done: false, active: undefined, lastPath: '', dsType: null };
    }

    function handleFrame(st, raw) {
        let line = raw.trim();
        if (!line) return;
        if (line.startsWith('data:')) line = line.slice(5).trim();
        else if (/^(event|id|retry):/.test(line)) return;
        else if (line.startsWith(':')) return;              // SSE comment / keepalive
        if (!line) return;
        if (line === '[DONE]') { st.done = true; return; }
        if (line[0] !== '{' && line[0] !== '[') return;
        let ev;
        try { ev = JSON.parse(line); } catch { return; }
        try { site.frame(st, ev); } catch (e) { log('[STREAM] adapter threw: ' + e.message); }
    }

    // Consume as much of buf as forms complete frames; return the remainder.
    function feedFrames(st, buf) {
        // Length-prefixed transports (Kimi's Connect RPC) have binary framing
        // bytes between the JSON objects, and a length byte can itself be 0x0A
        // or 0x7B - so neither newline splitting nor "starts with {" is safe.
        // Balancing braces ignores the framing entirely.
        if (site.scanJson) {
            for (;;) {
                let start = buf.indexOf('{');
                // A length byte of 0x7B is literally '{', and one sits directly
                // before a real frame in the measured capture ("{{"op":..."):
                // balancing from it never closes, which reads as "still
                // streaming" and stalls the stream forever. Real frames always
                // open with a string key, so require that before committing.
                while (start !== -1) {
                    const head = buf.slice(start, start + 3);
                    if (head.length < 3) return buf.slice(start);   // too short to judge
                    if (/^\{\s*"/.test(head)) break;
                    start = buf.indexOf('{', start + 1);
                }
                if (start === -1) return '';
                const obj = extractBalancedJson(buf, start);
                if (!obj) return buf.slice(start);        // incomplete, wait for more
                let ok = false;
                try { site.frame(st, JSON.parse(obj)); ok = true; }
                catch (e) { /* not a frame after all */ }
                // On failure advance one character rather than past the whole
                // candidate, so a false start cannot swallow the next frame.
                buf = ok ? buf.slice(start + obj.length) : buf.slice(start + 1);
            }
        }
        const frames = buf.split('\n');
        const rest = frames.pop();       // trailing partial frame
        frames.forEach(f => handleFrame(st, f));
        return rest;
    }

    async function consumeBody(body) {
        const st = makeStreamState();
        const reader = body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf = feedFrames(st, buf + dec.decode(value, { stream: true }));
        }
        // The stream may end without a trailing newline, leaving a COMPLETE
        // final frame sitting in buf. Dropping it loses the last delta - i.e.
        // the closing brace of a long payload.
        if (buf.trim() && !site.scanJson) handleFrame(st, buf);
        return st;
    }

    function consumeText(text) {
        const st = makeStreamState();
        const rest = feedFrames(st, text);
        if (rest.trim() && !site.scanJson) handleFrame(st, rest);
        return st;
    }

    async function deliver(st) {
        if (!st.done) log('[STREAM] ended without an explicit finish marker');
        const found = payloadsFromMarkdown(st.text);
        if (!found.length) return;
        console.log(`📥 [STREAM] ${found.length} payload(s) from response (${st.text.length} chars)`);
        streamSeen = true;
        await runBatch(found, 'stream');
    }

    function isAnswerUrl(url) {
        return !!site.urlRe && site.urlRe.test(url || '');
    }

    function installStreamHook() {
        const win = (typeof unsafeWindow !== 'undefined' && unsafeWindow) || window;
        if (!site.urlRe) return false;
        if (!win.fetch || win.__bridgeHooked) return false;
        win.__bridgeHooked = true;
        const orig = win.fetch;

        win.fetch = async function (...args) {
            const res = await orig.apply(this, args);
            try {
                const url = (typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url)) || '';
                if (!isAnswerUrl(url) || !res.body) return res;

                // clone() so the app still consumes the original untouched.
                const clone = res.clone();
                consumeBody(clone.body).then(deliver)
                    .catch(e => console.warn('[STREAM] reader failed:', e && e.message));
            } catch (e) {
                console.warn('[STREAM] hook error:', e && e.message);
            }
            return res;
        };
        return true;
    }

    // Some chats still stream over XMLHttpRequest. The whole responseText is
    // available at readyState 4 and the frame folder is order-independent, so
    // one pass at the end is enough - no need to track partial reads.
    function installXhrHook() {
        const win = (typeof unsafeWindow !== 'undefined' && unsafeWindow) || window;
        const XHR = win.XMLHttpRequest;
        if (!site.urlRe || !XHR || !XHR.prototype || win.__bridgeXhrHooked) return false;
        win.__bridgeXhrHooked = true;

        const open = XHR.prototype.open;
        XHR.prototype.open = function (method, url, ...rest) {
            try { this.__bridgeUrl = url; } catch {}
            return open.call(this, method, url, ...rest);
        };
        const send = XHR.prototype.send;
        XHR.prototype.send = function (...a) {
            try {
                if (isAnswerUrl(this.__bridgeUrl)) {
                    this.addEventListener('load', () => {
                        try {
                            const t = this.responseText;
                            if (typeof t === 'string' && t) deliver(consumeText(t));
                        } catch (e) { log('[XHR] read failed: ' + e.message); }
                    });
                }
            } catch (e) { log('[XHR] hook error: ' + e.message); }
            return send.apply(this, a);
        };
        return true;
    }

    let streamSeen = false;
    if (site.urlRe) {
        console.log(installStreamHook()
            ? '🔌 Response stream hook installed (primary source)'
            : '⚠️ Could not install stream hook - falling back to DOM scanning');
        installXhrHook();
    } else {
        console.log(`ℹ️ No stream adapter for ${site.name} - using DOM scanning`);
    }

    // A streaming response fires mutations constantly, so the handler stays
    // trivial - it only raises a flag that the ticker below acts on.
    new MutationObserver(() => { dirty = true; })
        .observe(document.documentElement, { childList: true, subtree: true, characterData: true });

    setInterval(() => scanAndExecute(false), TICK_MS);

    setInterval(() => {
        if (location.href !== lastUrl) {
            lastUrl = location.href;
            console.log("🔄 New chat detected.");
            scanAndExecute(true);
        }
    }, 1000);

    document.addEventListener('keydown', (e) => {
        if (e.ctrlKey && e.shiftKey && e.key === 'R') {
            e.preventDefault();
            console.log("🔥 Manual rescan triggered");
            if (typeof GM_listValues === 'function') {
                // bridge_hosts is configuration, not an execution record -
                // wiping it would silently un-enable every adopted chat site.
                GM_listValues()
                    .filter(k => k.startsWith('bridge_') && k !== 'bridge_hosts')
                    .forEach(k => GM_deleteValue(k));
                console.log("🗑️ Cleared all stored execution keys");
            }
            scanAndExecute(true);
        }
    });

})();
