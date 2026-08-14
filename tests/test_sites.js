// Each provider's stream adapter, driven with that provider's real frame shape.
// Every site gets two assertions: the payload fires, and the reasoning trace
// that arrives on the same stream is NOT executed.
const fs = require('fs');
const SRC = process.env.BRIDGE_SRC || require('path').join(__dirname, '..', 'userscript', 'bridge.user.js');
const src = fs.readFileSync(SRC, 'utf8');

let pass = 0, fail = 0;
const ck = (n, c, x) => { console.log((c ? '  PASS  ' : '  FAIL  ') + n); if (!c && x) console.log('        ' + x); c ? pass++ : fail++; };

const sent = [];
let store = new Map();

function env(host, body, chunk) {
    const bytes = new TextEncoder().encode(body);
    const parts = [];
    for (let i = 0; i < bytes.length; i += (chunk || 40)) parts.push(bytes.slice(i, i + (chunk || 40)));
    const mk = () => { let i = 0; return { body: { getReader: () => ({ read: async () => i < parts.length ? { done: false, value: parts[i++] } : { done: true } }) }, clone() { return mk(); } }; };

    const win = { fetch: async () => mk(), navigator: { clipboard: { writeText: async () => {} } },
                  HTMLTextAreaElement: { prototype: {} }, HTMLInputElement: { prototype: {} },
                  location: { href: `https://${host}/c/a`, hostname: host } };
    global.unsafeWindow = win; global.window = win; global.location = win.location;
    global.TextDecoder = TextDecoder;
    global.Event = class {}; global.KeyboardEvent = class {};
    global.MutationObserver = class { constructor(cb) { global.__mo = cb; } observe() {} };
    global.GM_getValue = (k, d) => store.has(k) ? store.get(k) : d;
    global.GM_setValue = (k, v) => store.set(k, v);
    global.GM_listValues = () => [...store.keys()];
    global.GM_deleteValue = k => store.delete(k);
    global.GM_xmlhttpRequest = o => { sent.push(JSON.parse(o.data));
        setTimeout(() => o.onload({ responseText: JSON.stringify({ results: [], render: 'x' }) }), 0); };
    const keys = [];
    global.__keys = keys;
    global.document = { documentElement: { children: [] }, querySelectorAll: () => [],
                        addEventListener(t, h) { if (t === 'keydown') keys.push(h); },
                        removeEventListener() {}, execCommand() {} };
    global.setInterval = () => 0;
    return win;
}

const sse = o => 'data: ' + JSON.stringify(o) + '\n\n';
const nd  = o => JSON.stringify(o) + '\n';

// The payload every site is asked to deliver, and the one none may deliver.
const good = id => '```json\n{"id":"' + id + '","calls":[{"tool":"list","path":"C:/t"}]}\n```';
const EVIL = '{"id":"evil","calls":[{"tool":"bash","cmd":"echo pwned"}]}';

async function drive(name, host, url, body, chunk) {
    console.log(`\n== ${name} ==`);
    sent.length = 0;
    const win = env(host, body, chunk);
    eval(src);
    await win.fetch(url, { method: 'POST' });
    await new Promise(r => setTimeout(r, 300));
    const calls = sent.flatMap(s => s.calls);
    ck(`${name}: payload executed`,
        calls.length === 1 && calls[0].tool === 'list' && calls[0].path === 'C:/t',
        JSON.stringify(calls));
    ck(`${name}: reasoning trace not executed`,
        !calls.some(c => c.tool === 'bash'),
        JSON.stringify(calls));
    return calls;
}

(async () => {
    // ── Qwen ────────────────────────────────────────────────
    await drive('qwen', 'chat.qwen.ai', '/api/v2/chat/completions?chat_id=a',
        sse({ choices: [{ delta: { content: EVIL, phase: 'think', status: 'typing' } }] }) +
        sse({ choices: [{ delta: { content: good('q_1'), phase: 'answer', status: 'typing' } }] }) +
        sse({ choices: [{ delta: { content: '', phase: 'answer', status: 'finished' } }] }));

    // ── ChatGPT ─────────────────────────────────────────────
    // Frame shapes below are copied from a LIVE capture (capture_chatgpt.txt),
    // not invented. In particular the snapshot and patch frames carry p:"" -
    // an empty string, not an absent key - which an earlier version of this
    // test got wrong and so failed to exercise the recipient gate at all.
    const g = good('c_1');
    await drive('chatgpt', 'chatgpt.com', '/backend-api/f/conversation',
        'event: delta_encoding\ndata: "v1"\n\n' +
        // a reasoning message first: content_type "thoughts", must go nowhere
        sse({ p: '', o: 'add', v: { message: { author: { role: 'assistant' }, recipient: 'all',
                              content: { content_type: 'thoughts', thoughts: [{ content: EVIL }] } } } }) +
        sse({ p: '/message/content/thoughts/0/content', o: 'append', v: EVIL }) +
        // then the real answer message
        sse({ p: '', o: 'add', v: { message: { author: { role: 'assistant' }, recipient: 'all',
                              content: { content_type: 'text', parts: [''] } } } }) +
        sse({ p: '/message/content/parts/0', o: 'append', v: g.slice(0, 10) }) +
        sse({ v: g.slice(10, 30) }) +
        sse({ v: g.slice(30) }) +
        sse({ p: '', o: 'patch', v: [ { p: '/message/content/parts/0', o: 'append', v: '\nDone.' },
                               { p: '/message/status', o: 'replace', v: 'finished_successfully' } ] }) +
        // Multi-part content, on the message that IS the answer. active is true
        // here, so the recipient gate cannot help: the parts/0 anchor is the
        // only thing between this and the payload scan.
        sse({ p: '/message/content/parts/1', o: 'append', v: EVIL }) +
        // A tool call to the python sandbox streams text at the SAME parts/0
        // path as the answer. Only the recipient check separates the two, so
        // this is the case that makes the active-message gate load-bearing.
        sse({ p: '', o: 'add', v: { message: { author: { role: 'assistant' }, recipient: 'python',
                              content: { content_type: 'text', parts: [''] } } } }) +
        sse({ p: '/message/content/parts/0', o: 'append', v: EVIL }) +
        'data: [DONE]\n\n');

    // A GET loading a conversation's HISTORY matches the answer URL pattern but
    // is a read, not a generation answer (fetch() defaults to GET). The body
    // carries the payload a POST would execute, so this proves the GET path is
    // what is gated - not the chatgpt adapter.
    {
        sent.length = 0;
        const gBody =
            'event: delta_encoding\ndata: "v1"\n\n' +
            sse({ p: '', o: 'add', v: { message: { author: { role: 'assistant' }, recipient: 'all',
                                  content: { content_type: 'text', parts: [good('cg_g')] } } } }) +
            sse({ p: '/message/status', o: 'replace', v: 'finished_successfully' }) +
            'data: [DONE]\n\n';
        const h = env('chatgpt.com', gBody, 64);
        delete global.__bridgeHooked;
        eval(src);
        await h.fetch('/backend-api/f/conversation/abc123');   // no method -> GET
        await new Promise(r => setTimeout(r, 200));
        ck('chatgpt: GET history load does not fire', sent.length === 0, JSON.stringify(sent));
    }

    // ── Claude ──────────────────────────────────────────────
    await drive('claude', 'claude.ai', '/api/organizations/o1/chat_conversations/c1/completion',
        sse({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: EVIL } }) +
        sse({ type: 'content_block_delta', delta: { type: 'text_delta', text: good('cl_1').slice(0, 25) } }) +
        sse({ type: 'content_block_delta', delta: { type: 'text_delta', text: good('cl_1').slice(25) } }) +
        sse({ type: 'message_stop' }));

    // ── Kimi ────────────────────────────────────────────────
    // Connect RPC, copied from a live capture (capture_kimi.txt): length-prefixed
    // binary framing around compact JSON, no "data:" and no newlines.
    // The prefix below is the real one that broke the first implementation - its
    // length byte is 0x7B, i.e. a literal '{' sitting immediately before a frame.
    const k = good('k_1');
    const pre = String.fromCharCode(0, 0, 0, 0, 0x7B);
    const kf = o => pre + JSON.stringify(o);
    await drive('kimi', 'www.kimi.com',
        'https://www.kimi.com/apiv2/kimi.gateway.chat.v1.ChatService/Chat',
        kf({ heartbeat: {} }) +
        // The user's own prompt is echoed back on the stream, twice. On this
        // bridge that prompt routinely IS a tool-call payload, so these two
        // masks must never reach the payload scanner.
        kf({ op: 'set', mask: 'chat.lastRequest', chat: { lastRequest: { text: EVIL } } }) +
        kf({ op: 'set', mask: 'message', message: { role: 'user', blocks: [{ text: { content: EVIL } }] } }) +
        // reasoning trace
        kf({ op: 'set', mask: 'block.think', block: { id: '3', think: { content: EVIL.slice(0, 20) } } }) +
        kf({ op: 'append', mask: 'block.think.content', block: { id: '3', think: { content: EVIL.slice(20) } } }) +
        // the answer: a "set" seed followed by appends, all concatenated
        kf({ op: 'set', mask: 'block.text', block: { id: '4', text: { content: k.slice(0, 12) } } }) +
        kf({ op: 'append', mask: 'block.text.content', block: { id: '4', text: { content: k.slice(12, 40) } } }) +
        kf({ op: 'append', mask: 'block.text.content', block: { id: '4', text: { content: k.slice(40) } } }) +
        kf({ op: 'set', mask: 'message.status', message: { status: 'MESSAGE_STATUS_COMPLETED' } }));

    // ── DeepSeek ────────────────────────────────────────────
    // Copied from a live capture. The critical detail: THINK and RESPONSE
    // fragments stream to the SAME path, so only the most recently created
    // fragment's type distinguishes reasoning from answer. Bare {"v":...}
    // frames inherit the previous path.
    const d = good('d_1');                       // begins with ```json\n
    await drive('deepseek', 'chat.deepseek.com', '/api/v0/chat/completion',
        'event: ready\n' + sse({ request_message_id: 13, response_message_id: 14 }) +
        // opening snapshot establishes a THINK fragment as current
        sse({ v: { response: { message_id: 14, thinking_enabled: true,
                               fragments: [{ id: 2, type: 'THINK', content: '' }] } } }) +
        sse({ p: 'response/fragments/-1/content', o: 'APPEND', v: EVIL.slice(0, 30) }) +
        sse({ v: EVIL.slice(30) }) +                       // inherits the path
        sse({ p: 'response/fragments/-1/elapsed_secs', o: 'SET', v: 0.729 }) +
        // a RESPONSE fragment becomes current, carrying its own opening content
        sse({ p: 'response/fragments', o: 'APPEND',
              v: [{ id: 3, type: 'RESPONSE', content: d.slice(0, 3), stage_id: 1 }] }) +
        sse({ p: 'response/fragments/-1/content', o: 'APPEND', v: d.slice(3, 30) }) +
        sse({ v: d.slice(30) }) +                          // inherits the path
        sse({ p: 'response', o: 'BATCH', v: [{ p: 'accumulated_token_usage', v: 603 },
                                             { p: 'quasi_status', v: 'FINISHED' }] }) +
        sse({ p: 'response/status', o: 'SET', v: 'FINISHED' }));

    // Thinking disabled: the FIRST fragment is the answer, and it arrives only
    // in the opening snapshot. Skip that snapshot and the fragment type is
    // never learned and its opening text is lost - a case the thinking-enabled
    // transcript above cannot expose, because there the answer fragment is
    // created by a later frame.
    const d2 = good('d_2');
    await drive('deepseek (thinking off)', 'chat.deepseek.com', '/api/v0/chat/completion',
        sse({ v: { response: { message_id: 9, thinking_enabled: false,
                               fragments: [{ id: 1, type: 'RESPONSE', content: d2.slice(0, 8) }] } } }) +
        sse({ p: 'response/fragments/-1/content', o: 'APPEND', v: d2.slice(8, 35) }) +
        sse({ v: d2.slice(35) }) +
        sse({ p: 'response/status', o: 'SET', v: 'FINISHED' }));

    // ── Gemini ──────────────────────────────────────────────
    // Google's batchexecute envelope, copied from a live capture: a ")]}'"
    // guard, then alternating length / JSON-array lines. Each chunk is a FULL
    // snapshot of the answer, not a delta.
    console.log('\n== gemini ==');
    {
        const wrb = txt => {
            const inner = JSON.stringify([null, ['c_1', 'r_1'], null, null, [['rc_1', [txt]]]]);
            const line = JSON.stringify([['wrb.fr', null, inner]]);
            return line.length + '\n' + line + '\n';
        };
        const g = good('gm_1');
        const body = ")]}'\n\n" + wrb(g.slice(0, 20)) + wrb(g.slice(0, 45)) + wrb(g);
        sent.length = 0;
        // Concatenating snapshots cannot be caught by counting calls: every
        // snapshot is a PREFIX of the final one, so gluing them together only
        // repeats text the payload dedupe drops again. What it does change is
        // the answer the adapter reconstructed - so measure that. The script
        // reports its length when it delivers, which is the only view of it
        // from out here.
        const logged = [];
        const realLog = console.log;
        console.log = (...a) => { logged.push(a.join(' ')); realLog(...a); };
        const w = env('gemini.google.com', body, 64);
        eval(src);
        await w.fetch('/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?bl=x', { method: 'POST' });
        await new Promise(r => setTimeout(r, 300));
        const calls = sent.flatMap(s => s.calls);
        ck('gemini: payload executed',
            calls.length === 1 && calls[0].tool === 'list' && calls[0].path === 'C:/t',
            JSON.stringify(calls));
        console.log = realLog;
        const chars = (logged.map(l => /payload\(s\) from response \((\d+) chars\)/.exec(l))
            .find(Boolean) || [])[1];
        ck('gemini: snapshots replace rather than concatenate',
            Number(chars) === g.length,
            `answer was ${chars} chars, the last snapshot is ${g.length} - ` +
            `${20 + 45 + g.length} would mean every snapshot was appended`);
    }

    // Walking back from a marker must land on the object that ENCLOSES it. A
    // nearer '{' that closes before the marker is a different value entirely.
    //
    // Normally the dedupe hides a wrong pick, because anything nested was
    // scanned - and so recorded - before the outer marker was reached. Not
    // here: pushing the inner payload resumes the marker scan past the end of
    // it, so the "legacy" object inside it is never scanned on its own. It is
    // unseen, it parses, and it has a commands array, which makes it exactly
    // the wrong thing to mistake for the outer payload.
    console.log('\n== payload extraction: enclosing object ==');
    {
        const nested =
            '{"id":"o_1",' +
              '"doc":{"id":"p_1","calls":[{"tool":"list","path":"C:/t"}],' +
                     '"legacy":{"commands":["echo pwned"]}},' +
              '"calls":[{"tool":"list","path":"C:/t"}]}';
        sent.length = 0;
        const w = env('chat.qwen.ai',
            sse({ choices: [{ delta: { content: '```json\n' + nested + '\n```', phase: 'answer', status: 'typing' } }] }) +
            sse({ choices: [{ delta: { content: '', phase: 'answer', status: 'finished' } }] }), 4096);
        eval(src);
        await w.fetch('/api/v2/chat/completions?chat_id=nest', { method: 'POST' });
        await new Promise(r => setTimeout(r, 300));
        const calls = sent.flatMap(s => s.calls);
        ck('nested commands array is never mistaken for the payload',
            !calls.some(c => c.tool === 'bash'), JSON.stringify(calls));
        ck('both real payloads still execute',
            calls.length === 2 && calls.every(c => c.tool === 'list'), JSON.stringify(calls));
    }

    // ── Grok ────────────────────────────────────────────────
    // Grok is DOM-scanning only: its answer never crosses a page-level
    // transport, so no stream hook should be installed at all. Matching its
    // conversation URLs would be actively harmful - load-responses returns the
    // whole history, including payloads already executed.
    console.log('\n== grok (DOM-only by design) ==');
    {
        sent.length = 0;
        const w = env('grok.com',
            nd({ result: { response: { token: good('g_1'), isThinking: false } } }));
        const untouched = w.fetch;
        eval(src);
        ck('grok: no stream hook installed', w.fetch === untouched);
        await w.fetch('https://grok.com/rest/app-chat/conversations/1/load-responses');
        await new Promise(r => setTimeout(r, 200));
        ck('grok: history endpoint executes nothing', sent.length === 0, JSON.stringify(sent));
    }

    // ── unknown host: dormant, then adopted ─────────────────
    console.log('\n== unknown host ==');
    sent.length = 0; store = new Map();
    const w1 = env('some-random-blog.example', sse({ choices: [{ delta: { content: good('x_1') } }] }));
    const untouched = w1.fetch;
    eval(src);
    ck('does not hook an unclaimed site', w1.fetch === untouched);
    await w1.fetch('/api/chat/completions');
    await new Promise(r => setTimeout(r, 200));
    ck('executes nothing on an unclaimed site', sent.length === 0, JSON.stringify(sent));

    console.log('\n== unknown host after Ctrl+Shift+B ==');
    store.set('bridge_hosts', ['my-chat.example']);
    await drive('generic (adopted)', 'my-chat.example', '/api/chat/completions',
        sse({ choices: [{ delta: { content: good('gen_1'), phase: 'answer' } }] }) +
        'data: [DONE]\n\n');

    // Ctrl+Shift+R must not wipe the adopted-host list.
    console.log('\n== config survives a manual rescan ==');
    store.set('bridge_hosts', ['my-chat.example']);
    store.set('bridge_c_step_1', 123);
    env('chat.qwen.ai', '');
    eval(src);
    const press = e => global.__keys.forEach(h => h(Object.assign({ preventDefault() {} }, e)));
    press({ ctrlKey: true, shiftKey: true, key: 'R' });
    await new Promise(r => setTimeout(r, 50));
    ck('rescan handler actually ran (execution key cleared)',
        !store.has('bridge_c_step_1'), JSON.stringify([...store]));
    ck('rescan keeps bridge_hosts',
        JSON.stringify(store.get('bridge_hosts')) === '["my-chat.example"]',
        JSON.stringify([...store]));

    // Ctrl+Shift+B on a site with no adapter must adopt it.
    console.log('\n== Ctrl+Shift+B adopts the current host ==');
    store = new Map();
    env('another.example', '');
    eval(src);
    press({ ctrlKey: true, shiftKey: true, key: 'B' });
    ck('hotkey adds the host to bridge_hosts',
        JSON.stringify(store.get('bridge_hosts')) === '["another.example"]',
        JSON.stringify([...store]));
    press({ ctrlKey: true, shiftKey: true, key: 'B' });
    ck('hotkey toggles the host back off',
        JSON.stringify(store.get('bridge_hosts')) === '[]',
        JSON.stringify([...store]));

    console.log('\n' + (fail ? 'FAILURES' : 'ALL PASS') + `: ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})();
