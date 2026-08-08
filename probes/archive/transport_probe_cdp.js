/**
 * Which transport carries the answer, as seen FROM THE PAGE?
 *
 * This is the question that decides whether a Tampermonkey userscript can
 * intercept a site at all. The script runs in the page, so it can only hook
 * what the page itself calls: fetch, XMLHttpRequest, EventSource, WebSocket.
 * If the answer arrives by some other route, stream interception is impossible
 * there regardless of how the adapter is written, and the site must fall back
 * to DOM scanning.
 *
 *   SITE_RE='grok\.com' node transport_probe_cdp.js
 *
 * Hooks are installed via addInitScript + reload, so nothing is missed by
 * arriving late.
 */
const path = require('path');
const { chromium } = require(path.join(
    require('child_process').execSync('npm root -g', { encoding: 'utf8' }).trim(), 'playwright'));

const HOST_RE = new RegExp(process.env.SITE_RE || 'grok\\.com');
const PROMPT = process.env.PROMPT ||
    'Reply with ONLY the following, inside a ```json code block, and nothing else at all: ' +
    '{"id":"probe_t","calls":[{"tool":"list","path":"C:/temp"}]}';

function hookAll() {
    if (window.__tp) return;
    const tp = { fetch: [], xhr: [], es: [], ws: [], worker: [] };
    window.__tp = tp;
    const note = (bucket, url, extra) => tp[bucket].push({ url: String(url).slice(0, 160), ...extra });

    const of = window.fetch;
    window.fetch = function (...a) {
        const url = typeof a[0] === 'string' ? a[0] : (a[0] && a[0].url) || '';
        const rec = { url: String(url).slice(0, 160), bytes: 0 };
        tp.fetch.push(rec);
        return of.apply(this, a).then(res => {
            try {
                if (res.body) {
                    const c = res.clone();
                    (async () => {
                        const rd = c.body.getReader(); const dec = new TextDecoder(); let t = '';
                        for (;;) { const { done, value } = await rd.read(); if (done) break; t += dec.decode(value, { stream: true }); }
                        rec.bytes = t.length;
                        if (/calls|probe_t/.test(t)) rec.HASPAYLOAD = true;
                    })();
                }
            } catch {}
            return res;
        });
    };

    const oo = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (m, u, ...r) { this.__u = u; return oo.call(this, m, u, ...r); };
    const os = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (...a) {
        const rec = { url: String(this.__u).slice(0, 160), bytes: 0 };
        tp.xhr.push(rec);
        this.addEventListener('load', () => {
            try { const t = this.responseText || ''; rec.bytes = t.length; if (/calls|probe_t/.test(t)) rec.HASPAYLOAD = true; } catch {}
        });
        return os.apply(this, a);
    };

    if (window.EventSource) {
        const OE = window.EventSource;
        window.EventSource = function (url, cfg) {
            const es = new OE(url, cfg);
            const rec = { url: String(url).slice(0, 160), msgs: 0 };
            tp.es.push(rec);
            es.addEventListener('message', e => {
                rec.msgs++;
                if (/calls|probe_t/.test(String(e.data))) rec.HASPAYLOAD = true;
            });
            return es;
        };
        window.EventSource.prototype = OE.prototype;
    }

    const OW = window.WebSocket;
    window.WebSocket = function (url, p) {
        const ws = p === undefined ? new OW(url) : new OW(url, p);
        const rec = { url: String(url).slice(0, 160), msgs: 0 };
        tp.ws.push(rec);
        ws.addEventListener('message', e => {
            rec.msgs++;
            if (typeof e.data === 'string' && /calls|probe_t/.test(e.data)) rec.HASPAYLOAD = true;
        });
        return ws;
    };
    window.WebSocket.prototype = OW.prototype;

    // Workers are the interesting negative case: a userscript cannot reach
    // inside one, so merely recording that they were created is the finding.
    for (const k of ['Worker', 'SharedWorker']) {
        const O = window[k];
        if (!O) continue;
        window[k] = function (u, o) {
            note('worker', k + ' ' + u, {});
            return o === undefined ? new O(u) : new O(u, o);
        };
        window[k].prototype = O.prototype;
    }
}

(async () => {
    const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
    const page = browser.contexts().flatMap(c => c.pages()).find(p => HOST_RE.test(p.url()));
    if (!page) { console.error('no tab matching ' + HOST_RE); process.exit(1); }
    console.log('tab: ' + page.url().slice(0, 80));

    await page.addInitScript(hookAll);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(6000);

    let sent = false;
    for (const sel of ['div[contenteditable="true"]', '[role="textbox"]', 'textarea']) {
        const box = page.locator(sel).last();
        try {
            if (!await box.isVisible({ timeout: 3000 })) continue;
            await box.click(); await box.fill(PROMPT); await page.keyboard.press('Enter');
            sent = true; console.log('prompt sent via ' + sel); break;
        } catch {}
    }
    if (!sent) console.log('COULD NOT SEND - type it yourself now');
    await page.waitForTimeout(40000);

    const tp = await page.evaluate(() => window.__tp);
    for (const k of ['fetch', 'xhr', 'es', 'ws', 'worker']) {
        const rows = (tp[k] || []).filter(r => r.HASPAYLOAD || /completion|conversation|responses|stream/i.test(r.url));
        console.log(`\n=== ${k} (${(tp[k] || []).length} total, ${rows.length} relevant) ===`);
        rows.slice(0, 12).forEach(r => console.log(
            `  ${r.HASPAYLOAD ? '>>> CARRIES PAYLOAD <<< ' : ''}${r.bytes !== undefined ? String(r.bytes).padStart(7) + 'b ' : ''}${r.msgs !== undefined ? r.msgs + ' msgs ' : ''}${r.url}`));
    }
    const winner = ['fetch', 'xhr', 'es', 'ws'].find(k => (tp[k] || []).some(r => r.HASPAYLOAD));
    console.log('\n' + (winner
        ? `VERDICT: the page itself carries the answer over ${winner} - interceptable by a userscript.`
        : 'VERDICT: NO page-level transport carried the answer. A userscript cannot intercept this site; use DOM scanning.'));
    await browser.close();
})();
