/**
 * Captures the RAW answer stream from a live chat tab, so the SITES adapters in
 * userscript/bridge.user.js can be checked against what the provider actually sends
 * rather than what I assumed it sends.
 *
 * Like dom_probe_cdp.js it ATTACHES to a Chrome you launched yourself - logins
 * stay manual and nothing about them is automated.
 *
 *   1. "C:\Program Files\Google\Chrome\Application\chrome.exe" ^
 *        --remote-debugging-port=9222 --user-data-dir="C:/temp/chrome-debug"
 *   2. Log into the chat and open a conversation.
 *   3. node stream_probe_cdp.js
 *   4. Send a message asking for a ```json tool-call block.
 *
 * Writes capture_<site>.txt (raw bytes) and capture_<site>.json (summary).
 * Deliberately records EVERY request the tab makes, not just ones matching the
 * adapter, so a wrong urlRe shows up as "the answer came back on a URL we
 * ignored" instead of silently capturing nothing.
 */
const fs = require('fs');
const path = require('path');

function loadPlaywright() {
    try { return require('playwright'); } catch {}
    try {
        const root = require('child_process').execSync('npm root -g', { encoding: 'utf8' }).trim();
        return require(path.join(root, 'playwright'));
    } catch {
        console.error('playwright not found. Install with:  npm install -g playwright');
        process.exit(1);
    }
}
const { chromium } = loadPlaywright();

const FIXTURES = path.join(__dirname, '..', 'tests', 'fixtures');
const CDP = process.env.CDP_URL || 'http://127.0.0.1:9222';
const WAIT_S = parseInt(process.env.WAIT_S || '300', 10);

// Installed in the page's main world. Tees every response body so the app still
// consumes its own untouched, and keeps only what looks like an answer stream.
function installCapture() {
    if (window.__streamCap) return 'already installed';
    const cap = { reqs: [], bodies: {} };
    window.__streamCap = cap;

    const interesting = ct => /event-stream|x-ndjson|json-stream|octet-stream/i.test(ct || '');

    const record = (url, method, ct, status) => {
        const e = { url: String(url).slice(0, 300), method, ct: ct || '', status, bytes: 0, t: Date.now() };
        cap.reqs.push(e);
        return e;
    };

    const of = window.fetch;
    window.fetch = async function (...a) {
        const res = await of.apply(this, a);
        try {
            const url = typeof a[0] === 'string' ? a[0] : (a[0] && a[0].url) || '';
            const method = (a[1] && a[1].method) || (a[0] && a[0].method) || 'GET';
            const ct = res.headers && res.headers.get && res.headers.get('content-type');
            const e = record(url, method, ct, res.status);
            e.via = 'fetch';
            if (res.body && (interesting(ct) || /completion|conversation|chat|stream/i.test(url))) {
                const clone = res.clone();
                const key = 'f' + cap.reqs.length;
                e.key = key;
                cap.bodies[key] = '';
                (async () => {
                    const rd = clone.body.getReader();
                    const dec = new TextDecoder();
                    for (;;) {
                        const { done, value } = await rd.read();
                        if (done) break;
                        cap.bodies[key] += dec.decode(value, { stream: true });
                        e.bytes = cap.bodies[key].length;
                    }
                    e.done = true;
                })().catch(err => { e.err = String(err && err.message); });
            }
        } catch (err) { /* never break the page */ }
        return res;
    };

    const oo = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (m, u, ...r) { this.__u = u; this.__m = m; return oo.call(this, m, u, ...r); };
    const os = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (...a) {
        try {
            const e = record(this.__u, this.__m, '', 0);
            e.via = 'xhr';
            this.addEventListener('load', () => {
                try {
                    e.status = this.status;
                    e.ct = this.getResponseHeader('content-type') || '';
                    const t = this.responseText;
                    if (typeof t === 'string' && (interesting(e.ct) || /completion|conversation|chat|stream/i.test(String(this.__u)))) {
                        const key = 'x' + cap.reqs.length;
                        e.key = key; e.bytes = t.length; e.done = true;
                        cap.bodies[key] = t;
                    }
                } catch {}
            });
        } catch {}
        return os.apply(this, a);
    };

    return 'installed';
}

const siteOf = url => {
    const h = (url.match(/^https?:\/\/([^/]+)/) || [, ''])[1];
    if (/qwen\.ai$/.test(h)) return 'qwen';
    if (/(chatgpt\.com|chat\.openai\.com)$/.test(h)) return 'chatgpt';
    if (/(kimi\.com|kimi\.ai|moonshot\.cn)$/.test(h)) return 'kimi';
    if (/claude\.ai$/.test(h)) return 'claude';
    if (/deepseek\.com$/.test(h)) return 'deepseek';
    if (/grok\.com$/.test(h)) return 'grok';
    if (/z\.ai$/.test(h)) return 'zai';
    return null;
};

(async () => {
    let browser;
    try { browser = await chromium.connectOverCDP(CDP); }
    catch {
        console.error(`\n  Could not attach to ${CDP}. Launch a debuggable Chrome first:\n`);
        console.error('    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" \\');
        console.error('      --remote-debugging-port=9222 --user-data-dir="C:/temp/chrome-debug"\n');
        process.exit(1);
    }

    const pages = () => browser.contexts().flatMap(c => c.pages());
    const targets = pages().filter(p => siteOf(p.url()));
    console.log(`attached; ${pages().length} page(s), ${targets.length} chat tab(s):`);
    for (const p of targets) console.log(`  - [${siteOf(p.url())}] ${p.url().slice(0, 90)}`);
    if (!targets.length) {
        console.log('\n  Open a ChatGPT / Kimi / Qwen tab in that Chrome window and rerun.');
        await browser.close();
        process.exit(1);
    }

    for (const p of targets) {
        const r = await p.evaluate(installCapture).catch(e => 'FAILED: ' + e.message);
        console.log(`  hook on ${siteOf(p.url())}: ${r}`);
    }

    // With PROMPT set, ask each tab ourselves. Sending the message is the only
    // step that has to happen after the hook is installed, so automating it
    // removes the race where a reload wipes the hook before you type.
    const PROMPT = process.env.PROMPT;
    if (PROMPT) {
        for (const p of targets) {
            const site = siteOf(p.url());
            const sels = [site === 'chatgpt' ? '#prompt-textarea' : null,
                          'div[contenteditable="true"]', '[role="textbox"]', 'textarea']
                         .filter(Boolean);
            let ok = false;
            for (const s of sels) {
                const box = p.locator(s).last();
                try {
                    if (!await box.isVisible({ timeout: 1500 })) continue;
                    await box.click();
                    await box.fill(PROMPT);
                    await p.keyboard.press('Enter');
                    ok = true;
                    break;
                } catch {}
            }
            console.log(`  prompt -> ${site}: ${ok ? 'sent' : 'COULD NOT FIND COMPOSER - type it yourself'}`);
        }
    } else {
        console.log(`\n  >>> Now send a message in each tab asking for a json tool-call block. <<<`);
    }
    console.log(`  waiting up to ${WAIT_S}s...\n`);

    const written = new Set();
    for (let i = 0; i < WAIT_S / 2; i++) {
        for (const p of pages()) {
            const site = siteOf(p.url());
            if (!site || written.has(site)) continue;
            const cap = await p.evaluate(() => {
                const c = window.__streamCap;
                if (!c) return null;
                // Rank by content type, not size. ChatGPT's sentinel token blob
                // is an order of magnitude bigger than the answer stream, so
                // "largest body" picks the wrong request every time.
                const score = r => (/event-stream|ndjson|json-stream/i.test(r.ct || '') ? 2 : 0)
                                 + (/completion|conversation\b|\/responses/i.test(r.url) ? 1 : 0);
                const best = c.reqs.filter(r => r.key && c.bodies[r.key] && c.bodies[r.key].length > 200)
                                   .sort((a, b) => (score(b) - score(a)) || (b.bytes - a.bytes))[0];
                if (best && score(best) === 0) return null;   // nothing stream-shaped yet
                return { reqs: c.reqs.map(r => ({ url: r.url, via: r.via, ct: r.ct, status: r.status, bytes: r.bytes, done: r.done })),
                         best: best ? { url: best.url, via: best.via, ct: best.ct, bytes: best.bytes, done: best.done,
                                        body: c.bodies[best.key] } : null };
            }).catch(() => null);
            if (!cap || !cap.best || !cap.best.done) continue;

            fs.writeFileSync(path.join(FIXTURES, `capture_${site}.txt`), cap.best.body);
            fs.writeFileSync(path.join(FIXTURES, `capture_${site}.json`), JSON.stringify({
                site, url: cap.best.url, via: cap.best.via, contentType: cap.best.ct,
                bytes: cap.best.bytes, requests: cap.reqs,
            }, null, 2));
            written.add(site);
            console.log(`  ✅ ${site}: ${cap.best.bytes} bytes via ${cap.best.via}`);
            console.log(`     url: ${cap.best.url}`);
            console.log(`     ct : ${cap.best.ct}`);
            console.log(`     first frame: ${cap.best.body.split('\n').find(l => l.trim())?.slice(0, 160)}`);
            console.log(`     -> capture_${site}.txt\n`);
        }
        if (written.size === targets.length) break;
        if (i % 10 === 0 && i) console.log(`  ...${i * 2}s, captured: ${[...written].join(', ') || 'nothing yet'}`);
        await new Promise(r => setTimeout(r, 2000));
    }

    if (!written.size) console.log('\n  Captured nothing. Did the response actually stream in that tab?');
    else console.log(`\n  Done: ${[...written].join(', ')}. Now run:  node verify_capture.js`);
    await browser.close();          // detaches only; your Chrome stays open
})();
