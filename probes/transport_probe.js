/**
 * transport_probe_cdp.js, but it waits for the answer to actually appear before
 * reporting. The first run reported a verdict for a turn Grok never answered,
 * and a second reused a stale window.__tp from the first - both invalid.
 *
 * Uses a unique marker per run so "has it answered yet" cannot be satisfied by
 * a leftover message from an earlier attempt.
 *
 *   SITE_RE='grok\.com' node transport_probe2.js
 */
const path = require('path');
const { chromium } = require(path.join(
    require('child_process').execSync('npm root -g', { encoding: 'utf8' }).trim(), 'playwright'));

const HOST_RE = new RegExp(process.env.SITE_RE || 'grok\\.com');
const MARK = 'probe' + Date.now().toString(36).slice(-5);
const PROMPT = `Reply with ONLY the following, inside a \`\`\`json code block, and nothing else at all: ` +
    `{"id":"${MARK}","calls":[{"tool":"list","path":"C:/temp"}]}`;

function hookAll(mark) {
    const tp = { fetch: [], xhr: [], es: [], ws: [], worker: [], mark };
    window.__tp = tp;
    const has = t => typeof t === 'string' && (t.indexOf(mark) !== -1);

    const of = window.__origFetch || window.fetch;
    window.__origFetch = of;
    window.fetch = function (...a) {
        const url = typeof a[0] === 'string' ? a[0] : (a[0] && a[0].url) || '';
        const rec = { url: String(url).slice(0, 150), bytes: 0 };
        tp.fetch.push(rec);
        return of.apply(this, a).then(res => {
            try {
                if (res.body) {
                    const c = res.clone();
                    (async () => {
                        const rd = c.body.getReader(); const dec = new TextDecoder(); let t = '';
                        for (;;) { const { done, value } = await rd.read(); if (done) break; t += dec.decode(value, { stream: true }); }
                        rec.bytes = t.length;
                        if (has(t)) rec.HASMARK = true;
                    })();
                }
            } catch {}
            return res;
        });
    };

    const oo = window.__origOpen || XMLHttpRequest.prototype.open;
    window.__origOpen = oo;
    XMLHttpRequest.prototype.open = function (m, u, ...r) { this.__u = u; return oo.call(this, m, u, ...r); };
    const os = window.__origSend || XMLHttpRequest.prototype.send;
    window.__origSend = os;
    XMLHttpRequest.prototype.send = function (...a) {
        const rec = { url: String(this.__u).slice(0, 150), bytes: 0 };
        tp.xhr.push(rec);
        // responseText THROWS when responseType is not "" or "text", so reading
        // only that silently reports "nothing here" for any binary/stream XHR -
        // a false negative that looks exactly like "not interceptable".
        const read = () => {
            try {
                rec.rt = this.responseType || 'text';
                let t = '';
                if (!this.responseType || this.responseType === 'text') t = this.responseText || '';
                else if (this.responseType === 'arraybuffer' && this.response) t = new TextDecoder().decode(this.response);
                else if (this.responseType === 'blob') return;      // handled below
                else if (this.responseType === 'json') t = JSON.stringify(this.response || '');
                if (t.length > rec.bytes) rec.bytes = t.length;
                if (has(t)) rec.HASMARK = true;
            } catch (e) { rec.readErr = String(e && e.name); }
        };
        // Streaming XHRs deliver over progress; load alone can miss the content.
        this.addEventListener('progress', read);
        this.addEventListener('load', read);
        this.addEventListener('loadend', read);
        return os.apply(this, a);
    };

    if (window.EventSource) {
        const OE = window.__origES || window.EventSource;
        window.__origES = OE;
        window.EventSource = function (url, cfg) {
            const es = new OE(url, cfg);
            const rec = { url: String(url).slice(0, 150), msgs: 0 };
            tp.es.push(rec);
            es.addEventListener('message', e => { rec.msgs++; if (has(String(e.data))) rec.HASMARK = true; });
            return es;
        };
        window.EventSource.prototype = OE.prototype;
    }

    const OW = window.__origWS || window.WebSocket;
    window.__origWS = OW;
    window.WebSocket = function (url, p) {
        const ws = p === undefined ? new OW(url) : new OW(url, p);
        const rec = { url: String(url).slice(0, 150), msgs: 0 };
        tp.ws.push(rec);
        ws.addEventListener('message', e => { rec.msgs++; if (has(e.data)) rec.HASMARK = true; });
        return ws;
    };
    window.WebSocket.prototype = OW.prototype;

    for (const k of ['Worker', 'SharedWorker']) {
        const O = window['__orig' + k] || window[k];
        if (!O) continue;
        window['__orig' + k] = O;
        window[k] = function (u, o) {
            tp.worker.push({ url: k + ' ' + String(u).slice(0, 100) });
            return o === undefined ? new O(u) : new O(u, o);
        };
        window[k].prototype = O.prototype;
    }
}

(async () => {
    const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
    const page = browser.contexts().flatMap(c => c.pages()).find(p => HOST_RE.test(p.url()));
    if (!page) { console.error('no tab matching ' + HOST_RE); process.exit(1); }
    console.log('tab:    ' + page.url().slice(0, 80));
    console.log('marker: ' + MARK);

    // Reloading Grok raises a cookie preference modal that swallows the click,
    // so NO_RELOAD installs the hooks into the live page instead. hookAll keeps
    // the originals on window.__orig*, so calling it twice cannot double-wrap.
    if (process.env.NO_RELOAD) {
        await page.evaluate(hookAll, MARK);
        console.log('hooks installed in place (no reload)');
    } else {
        await page.addInitScript(hookAll, MARK);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(7000);
    }

    // Dismiss any consent/preference dialog sitting over the composer.
    for (const label of ['Close preference center', 'Accept all', 'Reject all', 'Got it']) {
        try {
            const b = page.locator(`button[aria-label="${label}"], button:has-text("${label}")`).first();
            if (await b.isVisible({ timeout: 800 })) { await b.click(); console.log('dismissed: ' + label); }
        } catch {}
    }

    let sent = false;
    for (const sel of ['div[contenteditable="true"]', '[role="textbox"]', 'textarea']) {
        const box = page.locator(sel).last();
        try {
            if (!await box.isVisible({ timeout: 3000 })) continue;
            await box.click(); await box.fill(PROMPT); await page.keyboard.press('Enter');
            sent = true; console.log('prompt sent via ' + sel); break;
        } catch {}
    }
    if (!sent) { console.log('COULD NOT SEND'); process.exit(1); }

    // Counting ">= 2 occurrences" fired instantly on DeepSeek, because the text
    // still sitting in the textarea counts alongside the sent message. Take a
    // baseline once the send has settled and wait for it to GROW instead.
    const count = () => page.evaluate(
        m => (((document.body || {}).innerText || '').match(new RegExp(m, 'g')) || []).length, MARK
    ).catch(() => 0);
    await page.waitForTimeout(2500);
    const baseline = await count();
    console.log('baseline marker count after send: ' + baseline);

    let answered = false;
    for (let i = 0; i < 50; i++) {
        await page.waitForTimeout(2000);
        answered = (await count()) > baseline;
        if (answered) { console.log(`answer appeared after ${i * 2}s`); await page.waitForTimeout(4000); break; }
    }
    if (!answered) { console.log('\nNO ANSWER within 100s - test inconclusive, nothing to conclude.'); await browser.close(); process.exit(1); }

    const tp = await page.evaluate(() => window.__tp);
    for (const k of ['fetch', 'xhr', 'es', 'ws', 'worker']) {
        const all = tp[k] || [];
        const rows = all.filter(r => r.HASMARK);
        console.log(`\n=== ${k}: ${all.length} calls, ${rows.length} carrying the marker ===`);
        rows.slice(0, 10).forEach(r => console.log(`  >>> ${r.bytes || r.msgs || ''} ${r.url}`));
        if (k === 'worker' && all.length) all.slice(0, 5).forEach(r => console.log(`  (created) ${r.url}`));
    }
    const winner = ['fetch', 'xhr', 'es', 'ws'].find(k => (tp[k] || []).some(r => r.HASMARK));
    console.log('\n' + (winner
        ? `VERDICT: answer reaches the page over ${winner} - a userscript CAN intercept it.`
        : 'VERDICT: no page-level transport carried the answer - a userscript CANNOT intercept this site; DOM scanning only.'));
    await browser.close();
})();
