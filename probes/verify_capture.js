/**
 * Replays each capture_<site>.txt through the ACTUAL userscript/bridge.user.js, in a fake
 * browser, and reports whether the bridge would have fired.
 *
 * This is the check that matters: the unit tests drive frame shapes I wrote
 * from memory, so they prove the adapter is self-consistent, not that it
 * matches the provider. Real bytes in, real verdict out.
 *
 *   node stream_probe_cdp.js     # capture from a live tab first
 *   node verify_capture.js
 */
const fs = require('fs');
const path = require('path');
const SRC = path.join(__dirname, '..', 'userscript', 'bridge.user.js');
const FIX = path.join(__dirname, '..', 'tests', 'fixtures');
const src = fs.readFileSync(SRC, 'utf8');

const HOST = {
    qwen: 'chat.qwen.ai', chatgpt: 'chatgpt.com', kimi: 'www.kimi.com',
    claude: 'claude.ai', deepseek: 'chat.deepseek.com', grok: 'grok.com',
    gemini: 'gemini.google.com',
};

// A capture whose name is not in HOST resolves to no site at all, so the script
// goes dormant and reports "DID NOT FIRE" for a reason that has nothing to do
// with the adapter. That silent false negative has bitten twice - fail loudly.
function hostFor(site) {
    if (!HOST[site]) {
        console.error(`\ncapture_${site}: no HOST entry - add one or the verdict is meaningless.`);
        process.exit(2);
    }
    return HOST[site];
}

function replay(site, url, body) {
    const sent = [];
    const bytes = new TextEncoder().encode(body);
    const parts = [];
    for (let i = 0; i < bytes.length; i += 3000) parts.push(bytes.slice(i, i + 3000));
    const mk = () => { let i = 0; return { body: { getReader: () => ({ read: async () => i < parts.length ? { done: false, value: parts[i++] } : { done: true } }) }, clone() { return mk(); } }; };

    const win = { fetch: async () => mk(), navigator: { clipboard: { writeText: async () => {} } },
                  HTMLTextAreaElement: { prototype: {} }, HTMLInputElement: { prototype: {} },
                  location: { href: `https://${hostFor(site)}/c/probe`, hostname: hostFor(site) } };
    global.unsafeWindow = win; global.window = win; global.location = win.location;
    global.TextDecoder = TextDecoder;
    global.Event = class {}; global.KeyboardEvent = class {};
    global.MutationObserver = class { observe() {} };
    const store = new Map();
    global.GM_getValue = (k, d) => store.has(k) ? store.get(k) : d;
    global.GM_setValue = (k, v) => store.set(k, v);
    global.GM_listValues = () => [...store.keys()];
    global.GM_deleteValue = k => store.delete(k);
    global.GM_xmlhttpRequest = o => { sent.push(JSON.parse(o.data));
        setTimeout(() => o.onload({ responseText: JSON.stringify({ results: [], render: 'x' }) }), 0); };
    global.document = { documentElement: {}, querySelectorAll: () => [],
                        addEventListener() {}, removeEventListener() {}, execCommand() {} };
    global.setInterval = () => 0;

    // Silence the script's own chatter; we report our own verdict.
    const realLog = console.log;
    console.log = () => {};
    eval(src);
    const hooked = win.fetch;
    console.log = realLog;

    return { sent, run: async () => { console.log = () => {}; await hooked(url, { method: 'POST' });
             await new Promise(r => setTimeout(r, 500)); console.log = realLog; return sent; } };
}

// Reaches into the script to reuse its own adapter table, so the diagnosis of a
// failure ("url did not match" vs "url matched but no text came out") is made
// with the same code that will run in the browser.
function adapterFor(site) {
    const m = src.match(/const SITES = \[([\s\S]*?)\n    \];/);
    if (!m) return null;
    const body = m[1];
    const re = new RegExp(`name: '${site}'[\\s\\S]*?urlRe: (null|\\/.*?\\/[a-z]*),`);
    const hit = body.match(re);
    return hit ? hit[1] : null;
}

(async () => {
    const caps = fs.readdirSync(FIX).filter(f => /^capture_.*\.txt$/.test(f));
    if (!caps.length) {
        console.log('No capture_*.txt files. Run: node stream_probe_cdp.js');
        process.exit(1);
    }

    let bad = 0;
    for (const f of caps) {
        const site = f.replace(/^capture_|\.txt$/g, '');
        const body = fs.readFileSync(path.join(FIX, f), 'utf8');
        const metaPath = path.join(FIX, `capture_${site}.json`);
        const meta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, 'utf8')) : {};
        const url = meta.url || '/unknown';

        console.log(`\n═══ ${site} ═══`);
        console.log(`  url        ${url}`);
        console.log(`  bytes      ${body.length}`);
        console.log(`  adapter    urlRe = ${adapterFor(site)}`);

        const urlSrc = adapterFor(site);
        if (urlSrc && urlSrc !== 'null') {
            const re = new RegExp(urlSrc.replace(/^\/|\/[a-z]*$/g, ''), (urlSrc.match(/\/([a-z]*)$/) || [, ''])[1]);
            console.log(`  url match  ${re.test(url) ? 'YES' : 'NO  <-- adapter would never see this stream'}`);
            if (!re.test(url)) bad++;
        }

        const { run } = replay(site, url, body);
        const sent = await run();
        const calls = sent.flatMap(s => s.calls);
        if (calls.length) {
            console.log(`  VERDICT    FIRED - ${calls.length} call(s)`);
            console.log(`             ${JSON.stringify(calls).slice(0, 220)}`);
        } else {
            console.log(`  VERDICT    DID NOT FIRE`);
            console.log(`             first frame: ${body.split('\n').find(l => l.trim())?.slice(0, 200)}`);
            bad++;
        }
    }
    console.log(bad ? `\n${bad} problem(s) - adapter needs adjusting.` : `\nAll captures fired.`);
    process.exit(bad ? 1 : 0);
})();
