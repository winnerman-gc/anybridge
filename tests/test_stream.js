// Drives the userscript's fetch hook with the REAL SSE bytes captured from Qwen.
const fs = require('fs');
const SRC = process.env.BRIDGE_SRC || require('path').join(__dirname, '..', 'userscript', 'bridge.user.js');
const src = fs.readFileSync(SRC, 'utf8');
const realSSE = fs.readFileSync(__dirname + '/fixtures/sse_raw.txt', 'utf8');

let pass = 0, fail = 0;
const ck = (n, c, x) => { console.log((c ? '  PASS  ' : '  FAIL  ') + n); if (!c && x) console.log('        ' + x); c ? pass++ : fail++; };

// ---- minimal environment ---------------------------------------------------
const sent = [];
function makeEnv(sseText) {
    const enc = new TextEncoder();
    // Feed the body in several chunks so frame-splitting across reads is exercised.
    const bytes = enc.encode(sseText);
    const parts = [];
    const step = Math.ceil(bytes.length / 7);
    for (let i = 0; i < bytes.length; i += step) parts.push(bytes.slice(i, i + step));

    const mkResponse = () => {
        let idx = 0;
        const body = { getReader: () => ({ read: async () => idx < parts.length ? { done: false, value: parts[idx++] } : { done: true } }) };
        return { body, clone() { return mkResponse(); } };
    };

    const win = {
        fetch: async () => mkResponse(),
        navigator: { clipboard: { writeText: async () => {} } },
        HTMLTextAreaElement: { prototype: {} },
        location: { href: 'https://chat.qwen.ai/c/abc' },
    };
    global.unsafeWindow = win;
    global.window = win;
    global.location = win.location;
    global.TextDecoder = TextDecoder;
    global.Event = class { constructor(t) { this.type = t; } };
    global.KeyboardEvent = class { constructor(t) { this.type = t; } };
    global.MutationObserver = class { constructor(cb) { global.__mo = cb; } observe() {} };
    const store = new Map();
    global.GM_getValue = (k, d) => store.has(k) ? store.get(k) : d;
    global.GM_setValue = (k, v) => store.set(k, v);
    global.GM_listValues = () => [...store.keys()];
    global.GM_deleteValue = k => store.delete(k);
    global.GM_xmlhttpRequest = o => {
        sent.push(JSON.parse(o.data));
        setTimeout(() => o.onload({ responseText: JSON.stringify({ results: [{ ok: true, tool: 'bash' }], render: '=== BRIDGE RESULT ===\nok\n=== END BRIDGE RESULT ===' }) }), 0);
    };
    global.document = {
        documentElement: { children: [] },
        querySelectorAll: () => [],
        addEventListener() {}, removeEventListener() {}, execCommand() {},
    };
    global.setInterval = () => 0;
    return win;
}

(async () => {
    console.log('== real captured SSE ==');
    const win = makeEnv(realSSE);
    eval(src);
    await win.fetch('/api/v2/chat/completions?chat_id=abc');
    await new Promise(r => setTimeout(r, 120));

    ck('hook fired on the real stream', sent.length === 1, JSON.stringify(sent).slice(0, 150));
    if (sent.length) {
        const calls = sent[0].calls;
        ck('recovered tool calls', Array.isArray(calls) && calls.length > 0, JSON.stringify(calls).slice(0, 200));
        console.log('        calls: ' + JSON.stringify(calls).slice(0, 220));
    }

    // A think-phase must never be treated as an instruction.
    console.log('\n== think phase is ignored ==');
    sent.length = 0;
    const thinky =
        'data: {"choices":[{"delta":{"role":"assistant","content":"{\\"id\\":\\"evil\\",\\"calls\\":[{\\"tool\\":\\"bash\\",\\"cmd\\":\\"echo pwned\\"}]}","phase":"think","status":"typing"}}]}\n\n' +
        'data: {"choices":[{"delta":{"role":"assistant","content":"```json\\n{\\"id\\":\\"good_1\\",\\"calls\\":[{\\"tool\\":\\"list\\",\\"path\\":\\"C:/t\\"}]}\\n```","phase":"answer","status":"typing"}}]}\n\n' +
        'data: {"choices":[{"delta":{"content":"","status":"finished","phase":"answer"}}]}\n\n';
    const win2 = makeEnv(thinky);
    delete global.__bridgeHooked;
    eval(src);
    await win2.fetch('/api/v2/chat/completions?chat_id=x');
    await new Promise(r => setTimeout(r, 120));
    ck('only the answer phase executed',
        sent.length === 1 && sent[0].calls.length === 1 && sent[0].calls[0].tool === 'list',
        JSON.stringify(sent).slice(0, 200));

    console.log('\n' + (fail ? 'FAILURES' : 'ALL PASS') + `: ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})();
