/**
 * Grok answers without the page ever making a visible network request, and it
 * runs a shared worker. This attaches CDP directly to the worker targets and
 * enables the Network domain there.
 *
 * The answer matters beyond diagnostics: a Tampermonkey userscript runs in the
 * page, so if the chat request is issued from a worker's global scope, hooking
 * window.fetch cannot see it at any speed - and that site needs DOM scanning
 * rather than stream interception.
 *
 *   SITE_RE='grok\.com' node worker_probe_cdp.js
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require(path.join(
    require('child_process').execSync('npm root -g', { encoding: 'utf8' }).trim(), 'playwright'));

const FIXTURES = path.join(__dirname, '..', 'tests', 'fixtures');
const HOST_RE = new RegExp(process.env.SITE_RE || 'grok\\.com');
const NAME = process.env.NAME || 'grok';
const PROMPT = process.env.PROMPT ||
    'Reply with ONLY the following, inside a ```json code block, and nothing else at all: ' +
    '{"id":"probe_w","calls":[{"tool":"list","path":"C:/temp"}]}';

const list = () => new Promise((res, rej) =>
    http.get('http://127.0.0.1:9222/json/list', r => {
        let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
    }).on('error', rej));

function attach(target) {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    let id = 0;
    const pending = new Map();
    const state = { target, reqs: new Map(), bodies: [] };
    const send = (method, params) => new Promise(res => {
        const n = ++id;
        pending.set(n, res);
        ws.send(JSON.stringify({ id: n, method, params: params || {} }));
    });
    ws.addEventListener('open', async () => {
        await send('Network.enable');
        await send('Runtime.runIfWaitingForDebugger').catch(() => {});
        console.log(`  attached: ${target.type} ${target.url.slice(0, 60)}`);
    });
    ws.addEventListener('message', ev => {
        const m = JSON.parse(ev.data);
        if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return; }
        if (m.method === 'Network.requestWillBeSent')
            state.reqs.set(m.params.requestId, { url: m.params.request.url, method: m.params.request.method });
        if (m.method === 'Network.responseReceived') {
            const r = state.reqs.get(m.params.requestId) || {};
            r.ct = (m.params.response.headers['content-type'] || m.params.response.headers['Content-Type'] || '');
            r.status = m.params.response.status;
        }
        if (m.method === 'Network.loadingFinished') {
            const r = state.reqs.get(m.params.requestId);
            if (!r) return;
            r.bytes = m.params.encodedDataLength;
            if (/completion|conversation|responses|chat|stream/i.test(r.url)) {
                send('Network.getResponseBody', { requestId: m.params.requestId })
                    .then(res => { if (res && res.body) state.bodies.push({ ...r, text: res.body }); })
                    .catch(() => {});
            }
        }
    });
    ws.addEventListener('error', () => {});
    return state;
}

(async () => {
    const targets = (await list()).filter(t =>
        /worker/i.test(t.type) && (HOST_RE.test(t.url) || /^blob:/.test(t.url)));
    console.log(`worker targets: ${targets.length}`);
    const states = targets.map(attach);
    await new Promise(r => setTimeout(r, 1500));

    const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
    const page = browser.contexts().flatMap(c => c.pages()).find(p => HOST_RE.test(p.url()));
    if (!page) { console.error('no page tab'); process.exit(1); }

    // Page-level view, for the side-by-side comparison.
    const pageReqs = [];
    page.on('response', res => pageReqs.push(res.url()));

    for (const sel of ['div[contenteditable="true"]', '[role="textbox"]', 'textarea']) {
        const box = page.locator(sel).last();
        try {
            if (!await box.isVisible({ timeout: 2000 })) continue;
            await box.click(); await box.fill(PROMPT); await page.keyboard.press('Enter');
            console.log('prompt sent'); break;
        } catch {}
    }

    await page.waitForTimeout(parseInt(process.env.WAIT_MS||'40000',10));

    console.log('\n--- requests seen BY THE WORKER ---');
    let any = null;
    for (const s of states) {
        for (const [, r] of s.reqs) {
            if (!/completion|conversation|responses|stream/i.test(r.url)) continue;
            console.log(`  ${String(r.bytes || 0).padStart(7)} ${r.method} ${(r.ct || '').slice(0, 28).padEnd(30)} ${r.url.slice(0, 95)}`);
        }
        const hit = s.bodies.filter(b => /calls|probe_w/.test(b.text)).sort((a, b) => b.text.length - a.text.length)[0];
        if (hit && !any) any = hit;
    }
    console.log('\n--- same window, seen BY THE PAGE ---');
    const pageHits = pageReqs.filter(u => /completion|conversation|responses|stream/i.test(u));
    console.log(pageHits.length ? pageHits.map(u => '  ' + u.slice(0, 95)).join('\n') : '  (none)');

    if (any) {
        fs.writeFileSync(path.join(FIXTURES, `capture_${NAME}.txt`), any.text);
        fs.writeFileSync(path.join(FIXTURES, `capture_${NAME}.json`),
            JSON.stringify({ site: NAME, url: any.url, contentType: any.ct, bytes: any.text.length }, null, 2));
        console.log(`\n✅ saved capture_${NAME}.txt  (${any.text.length} bytes)`);
        console.log(`   url : ${any.url}`);
        console.log(`   ct  : ${any.ct}`);
        console.log(`   head: ${any.text.split('\n').filter(l => l.trim())[0]?.slice(0, 220)}`);
    } else {
        console.log('\n❌ no answer body recovered from the worker either.');
    }
    await browser.close();
    process.exit(0);
})();
