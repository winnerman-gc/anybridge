// The reported failure: a very long payload, streamed slowly in small chunks,
// whose content contains ``` fences of its own.
const fs = require('fs');
const SRC = process.env.BRIDGE_SRC || require('path').join(__dirname, '..', 'userscript', 'bridge.user.js');
const src = fs.readFileSync(SRC, 'utf8');

let pass = 0, fail = 0;
const ck = (n, c, x) => { console.log((c ? '  PASS  ' : '  FAIL  ') + n); if (!c && x) console.log('        ' + x); c ? pass++ : fail++; };

const sent = [];
function env(sse, chunkSize) {
    const bytes = new TextEncoder().encode(sse);
    const parts = [];
    for (let i = 0; i < bytes.length; i += chunkSize) parts.push(bytes.slice(i, i + chunkSize));
    const mk = () => { let i = 0; return { body: { getReader: () => ({ read: async () => i < parts.length ? { done: false, value: parts[i++] } : { done: true } }) }, clone() { return mk(); } }; };
    const win = { fetch: async () => mk(), navigator: { clipboard: { writeText: async () => {} } },
                  HTMLTextAreaElement: { prototype: {} }, location: { href: 'https://chat.qwen.ai/c/a' } };
    global.unsafeWindow = win; global.window = win; global.location = win.location;
    global.TextDecoder = TextDecoder;
    global.Event = class {}; global.KeyboardEvent = class {};
    global.MutationObserver = class { constructor(cb) { global.__mo = cb; } observe() {} };
    const store = new Map();
    global.GM_getValue = (k, d) => store.has(k) ? store.get(k) : d;
    global.GM_setValue = (k, v) => store.set(k, v);
    global.GM_listValues = () => [...store.keys()];
    global.GM_deleteValue = k => store.delete(k);
    global.GM_xmlhttpRequest = o => { sent.push(JSON.parse(o.data));
        setTimeout(() => o.onload({ responseText: JSON.stringify({ results: [], render: 'x' }) }), 0); };
    global.document = { documentElement: { children: [] }, querySelectorAll: () => [],
                        addEventListener() {}, removeEventListener() {}, execCommand() {} };
    global.setInterval = () => 0;
    return win;
}

// A 500-line markdown file, containing its own ``` fences.
const lines = [];
for (let i = 1; i <= 500; i++) {
    if (i % 50 === 0) { lines.push('```python'); lines.push(`print(${i})`); lines.push('```'); }
    else lines.push(`Line ${i}: content with "quotes" and \\ backslash and {braces}.`);
}
const payload = { id: 'big_1', calls: [{ tool: 'write', path: 'C:/temp/big.md', lines }] };
const answer = 'Here you go:\n\n```json\n' + JSON.stringify(payload, null, 2) + '\n```\n\nDone.';

function sseFor(text, deltaSize) {
    let out = '';
    for (let i = 0; i < text.length; i += deltaSize) {
        const piece = text.slice(i, i + deltaSize);
        out += 'data: ' + JSON.stringify({ choices: [{ delta: { role: 'assistant', content: piece, phase: 'answer', status: 'typing' } }] }) + '\n\n';
    }
    out += 'data: ' + JSON.stringify({ choices: [{ delta: { content: '', status: 'finished', phase: 'answer' } }] }) + '\n\n';
    return out;
}

(async () => {
    console.log(`payload: ${lines.length} lines, answer ${answer.length} chars, ` +
                `contains ${(answer.match(/```/g) || []).length} fence markers`);

    console.log('\n== 500-line payload with inner ``` fences, tiny deltas, tiny chunks ==');
    const win = env(sseFor(answer, 7), 64);      // 7-char deltas, 64-byte network chunks
    eval(src);
    await win.fetch('/api/v2/chat/completions?chat_id=a', { method: 'POST' });
    await new Promise(r => setTimeout(r, 400));
    ck('payload fired', sent.length === 1, `sent=${sent.length}`);
    if (sent.length) {
        ck('all ' + lines.length + ' lines recovered', sent[0].calls[0].lines.length === lines.length,
            'got ' + sent[0].calls[0].lines.length);
        ck('inner fences preserved', sent[0].calls[0].lines[49] === '```python',
            JSON.stringify(sent[0].calls[0].lines[49]));
        ck('last line intact', sent[0].calls[0].lines[499] === lines[499],
            JSON.stringify(sent[0].calls[0].lines[499]));
    }

    console.log('\n== stream ending WITHOUT trailing blank line ==');
    sent.length = 0;
    const noTrail = sseFor(answer, 40).replace(/\n\n$/, '');
    const w2 = env(noTrail, 128); delete global.__bridgeHooked; eval(src);
    await w2.fetch('/api/v2/chat/completions?chat_id=b', { method: 'POST' });
    await new Promise(r => setTimeout(r, 400));
    ck('final frame not lost', sent.length === 1 && sent[0].calls[0].lines.length === lines.length,
        `sent=${sent.length}`);

    console.log('\n== two payloads in one answer, second not dropped while busy ==');
    sent.length = 0;
    const two = '```json\n{"id":"a_1","calls":[{"tool":"list","path":"C:/t"}]}\n```\n\n' +
                '```json\n{"id":"a_2","calls":[{"tool":"list","path":"C:/u"}]}\n```';
    const w3 = env(sseFor(two, 20), 64); delete global.__bridgeHooked; eval(src);
    await w3.fetch('/api/v2/chat/completions?chat_id=c', { method: 'POST' });
    await new Promise(r => setTimeout(r, 2600));
    const allCalls = sent.flatMap(s => s.calls);
    ck('both payloads executed', allCalls.length === 2, JSON.stringify(allCalls));

    // Prose about sets, templates or LaTeX carries a lot of unclosed braces.
    // Scanning forward from every '{' needs a cap to stay affordable, and the
    // cap silently swallowed any payload that came after enough of them.
    console.log('\n== payload after thousands of unclosed braces ==');
    sent.length = 0;
    const noise = 'Consider the set {a, b, c and the mapping {x -> y for each. '.repeat(3000);
    const noisy = noise + '\n```json\n' +
        JSON.stringify({ id: 'noise_1', calls: [{ tool: 'list', path: 'C:/t' }] }) + '\n```';
    const w4 = env(sseFor(noisy, 400), 8192);
    eval(src);
    await w4.fetch('/api/v2/chat/completions?chat_id=d', { method: 'POST' });
    await new Promise(r => setTimeout(r, 500));
    ck('payload after 6000 stray braces still fires',
        sent.length === 1 && sent[0].calls[0].tool === 'list',
        `sent=${sent.length}`);

    // The enclosing object must actually contain the marker.
    console.log('\n== nearer object that closes before the marker ==');
    sent.length = 0;
    const tricky = 'Note {"unrelated": "value"} then the real one:\n```json\n' +
        JSON.stringify({ id: 'tricky_1', calls: [{ tool: 'list', path: 'C:/t' }] }) + '\n```';
    const w5 = env(sseFor(tricky, 30), 256);
    eval(src);
    await w5.fetch('/api/v2/chat/completions?chat_id=e', { method: 'POST' });
    await new Promise(r => setTimeout(r, 400));
    ck('picks the object that encloses the marker',
        sent.length === 1 && sent[0].calls.length === 1 && sent[0].calls[0].path === 'C:/t',
        JSON.stringify(sent.flatMap(s => s.calls)));

    // Walking back from the marker, the FIRST '{' encountered belongs to the
    // nested object, which closes before the marker. The walk has to keep going
    // to the real payload brace rather than settling for it.
    console.log('\n== nested object sits between the brace and the marker ==');
    sent.length = 0;
    const nested = '```json\n' + JSON.stringify({
        meta: { note: 'ignore me', deep: { deeper: true } },
        id: 'nested_1',
        calls: [{ tool: 'list', path: 'C:/t' }],
    }, null, 2) + '\n```';
    const w6 = env(sseFor(nested, 25), 128);
    eval(src);
    await w6.fetch('/api/v2/chat/completions?chat_id=f', { method: 'POST' });
    await new Promise(r => setTimeout(r, 400));
    ck('skips the nested object and finds the payload',
        sent.length === 1 && sent[0].calls.length === 1 && sent[0].calls[0].path === 'C:/t',
        JSON.stringify(sent.flatMap(s => s.calls)));

    console.log('\n' + (fail ? 'FAILURES' : 'ALL PASS') + `: ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})();
