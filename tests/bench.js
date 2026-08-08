// End-to-end cost of one response, from bytes arriving to the batch being sent.
// Drives the real userscript, so it measures what actually ships.
const fs = require('fs');
const SRC = process.env.BRIDGE_SRC || require('path').join(__dirname, '..', 'userscript', 'bridge.user.js');
const src = fs.readFileSync(SRC, 'utf8');

function env(host, body, chunk) {
    const sent = [];
    const bytes = new TextEncoder().encode(body);
    const parts = [];
    for (let i = 0; i < bytes.length; i += chunk) parts.push(bytes.slice(i, i + chunk));
    const mk = () => { let i = 0; return { body: { getReader: () => ({ read: async () => i < parts.length ? { done: false, value: parts[i++] } : { done: true } }) }, clone() { return mk(); } }; };
    const win = { fetch: async () => mk(), navigator: { clipboard: { writeText: async () => {} } },
                  HTMLTextAreaElement: { prototype: {} }, HTMLInputElement: { prototype: {} },
                  location: { href: `https://${host}/c/a`, hostname: host } };
    global.unsafeWindow = win; global.window = win; global.location = win.location;
    global.TextDecoder = TextDecoder;
    global.Event = class {}; global.KeyboardEvent = class {};
    global.MutationObserver = class { observe() {} };
    const store = new Map();
    global.GM_getValue = (k, d) => store.has(k) ? store.get(k) : d;
    global.GM_setValue = (k, v) => store.set(k, v);
    global.GM_listValues = () => [...store.keys()];
    global.GM_deleteValue = k => store.delete(k);
    global.GM_xmlhttpRequest = o => { sent.push({ t: process.hrtime.bigint(), data: JSON.parse(o.data) });
        setTimeout(() => o.onload({ responseText: '{"results":[],"render":"x"}' }), 0); };
    global.document = { documentElement: {}, querySelectorAll: () => [],
                        addEventListener() {}, removeEventListener() {}, execCommand() {} };
    global.setInterval = () => 0;
    return { win, sent };
}

const qwenSSE = text => {
    let out = '';
    for (let i = 0; i < text.length; i += 400)
        out += 'data: ' + JSON.stringify({ choices: [{ delta: { content: text.slice(i, i + 400), phase: 'answer', status: 'typing' } }] }) + '\n\n';
    return out + 'data: ' + JSON.stringify({ choices: [{ delta: { content: '', status: 'finished', phase: 'answer' } }] }) + '\n\n';
};

const kimiFrames = text => {
    const pre = String.fromCharCode(0, 0, 0, 0, 0x7B);
    let out = pre + JSON.stringify({ op: 'set', mask: 'block.text', block: { id: '4', text: { content: '' } } });
    for (let i = 0; i < text.length; i += 400)
        out += pre + JSON.stringify({ op: 'append', mask: 'block.text.content', block: { id: '4', text: { content: text.slice(i, i + 400) } } });
    return out + pre + JSON.stringify({ op: 'set', mask: 'message.status', message: { status: 'MESSAGE_STATUS_COMPLETED' } });
};

async function run(label, host, url, body, chunk, expectFire) {
    const { win, sent } = env(host, body, chunk);
    const realLog=console.log; console.log=()=>{};
    const t0 = process.hrtime.bigint();
    eval(src);
    await win.fetch(url);
    for (let i = 0; i < 400 && !sent.length; i++) await new Promise(r => setTimeout(r, 5));
    console.log=realLog;
    const ms = sent.length ? Number(sent[0].t - t0) / 1e6 : NaN;
    const ok = sent.length > 0;
    console.log(`  ${label.padEnd(42)} ${(body.length / 1024).toFixed(0).padStart(5)}KB  ` +
        (ok ? `${ms.toFixed(0).padStart(6)} ms` : '   DID NOT FIRE') +
        (ok === !!expectFire ? '' : '   <-- UNEXPECTED'));
    return ms;
}

(async () => {
    // A big realistic write: 2000 lines of code, full of braces and quotes.
    const lines = [];
    for (let i = 1; i <= 2000; i++)
        lines.push(`  const item${i} = { id: ${i}, name: "row ${i}", tags: ["a","b"], fn: () => { return ${i}; } };`);
    const payload = { id: 'bench_1', calls: [{ tool: 'write', path: 'C:/temp/big.js', lines }] };
    const answer = 'Here is the file:\n\n```json\n' + JSON.stringify(payload, null, 1) + '\n```\n\nDone.';

    // Worst case for a brace scanner: lots of opening braces that never close.
    const noise = 'Consider the set {a, b, c and the mapping {x -> y for each of these. '.repeat(3000);
    const noisyAnswer = noise + '\n```json\n' + JSON.stringify({ id: 'n_1', calls: [{ tool: 'list', path: 'C:/t' }] }) + '\n```';

    // An answer with no payload at all - the common case, must stay cheap.
    const prose = 'The quick brown fox jumps over the lazy dog. '.repeat(4000);

    console.log('\n=== one response, end to end ===');
    await run('qwen: 2000-line write', 'chat.qwen.ai', '/api/v2/chat/completions', qwenSSE(answer), 16384, true);
    await run('kimi: 2000-line write (Connect)', 'www.kimi.com',
        'https://www.kimi.com/apiv2/kimi.gateway.chat.v1.ChatService/Chat', kimiFrames(answer), 16384, true);
    await run('qwen: unclosed-brace noise + payload', 'chat.qwen.ai', '/api/v2/chat/completions',
        qwenSSE(noisyAnswer), 16384, true);
    await run('qwen: plain prose, no payload', 'chat.qwen.ai', '/api/v2/chat/completions',
        qwenSSE(prose), 16384, false);
    process.exit(0);
})();
