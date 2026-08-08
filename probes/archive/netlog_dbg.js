/**
 * Where does the answer actually come from?
 *
 * The in-page fetch/XHR/WebSocket hooks all missed Kimi's response, which means
 * either the hook was installed too late or the transport is something else.
 * Playwright's own network events sit below the page's JavaScript, so they see
 * every request whatever the app does - no hooking, nothing to miss.
 *
 *   SITE_RE=kimi node netlog_cdp.js
 *
 * Logs every response that arrives after the prompt is sent, and saves the body
 * of anything that looks like a stream.
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require(path.join(
    require('child_process').execSync('npm root -g', { encoding: 'utf8' }).trim(), 'playwright'));

const CDP = process.env.CDP_URL || 'http://127.0.0.1:9222';
const MATCH = new RegExp(process.env.SITE_RE || 'kimi');
const NAME = process.env.NAME || (process.env.SITE_RE || 'kimi').replace(/[^a-z0-9]/gi, '');
const PROMPT = process.env.PROMPT ||
    'Reply with ONLY the following, inside a ```json code block, and nothing else at all: ' +
    '{"id":"probe_net","calls":[{"tool":"list","path":"C:/temp"}]}';

(async () => {
    const browser = await chromium.connectOverCDP(CDP);
    const page = browser.contexts().flatMap(c => c.pages()).find(p => MATCH.test(p.url()));
    if (!page) { console.error('no tab matching ' + MATCH); process.exit(1); }
    console.log('tab: ' + page.url().slice(0, 90));

    const seen = [];
    const bodies = [];
    page.on('response', async res => {
        const req = res.request();
        const url = res.url();
        if (/\.(png|jpe?g|svg|woff2?|css|riv|ico|mp4)(\?|$)/i.test(url)) return;
        const ct = (res.headers()['content-type'] || '');
        const rec = { url: url.slice(0, 200), method: req.method(), status: res.status(), ct: ct.slice(0, 40) };
        seen.push(rec);
        // Grab the body of anything plausibly carrying an answer.
        if (/event-stream|ndjson|json-stream/i.test(ct) ||
            /completion|conversation|stream|chat/i.test(url)) {
            try {
                const buf = await res.body();
                rec.bytes = buf.length;
                if (buf.length > 100) bodies.push({ ...rec, text: buf.toString('utf8') });
            } catch (e) { rec.bodyErr = e.message.slice(0, 60); }
        }
    });
    page.on('websocket', ws => {
        console.log('  [ws] ' + ws.url().slice(0, 120));
        ws.on('framereceived', f => {
            const d = f.payload;
            if (typeof d === 'string' && d.length > 80) bodies.push({ url: 'WS ' + ws.url().slice(0, 80), ct: 'websocket', bytes: d.length, text: d });
        });
    });

    let sent = false;
    for (const sel of ['div[contenteditable="true"]', '[role="textbox"]', 'textarea']) {
        const box = page.locator(sel).last();
        try {
            if (!await box.isVisible({ timeout: 2000 })) continue;
            await box.click(); await box.fill(PROMPT); await page.keyboard.press('Enter');
            sent = true; console.log('prompt sent via ' + sel); break;
        } catch {}
    }
    if (!sent) console.log('COULD NOT SEND - type it yourself now');

    console.log('watching for 45s...\n');
    await page.waitForTimeout(45000);

    console.log(`responses seen: ${seen.length}`);
    const interesting = seen; console.log("--- ALL POSTs ---"); seen.filter(r=>r.method==="POST").forEach(r=>console.log(String(r.bytes||0).padStart(8), r.status, r.ct.padEnd(30), r.url.slice(0,110)));
    console.log('\n--- candidates ---');
    for (const r of interesting.sort((a, b) => (b.bytes || 0) - (a.bytes || 0)).slice(0, 40))
        console.log(String(r.bytes || 0).padStart(8), r.method.padEnd(5), r.ct.padEnd(34), r.url.slice(0, 100));

    const best = bodies.filter(b => /calls|probe_net/.test(b.text))
                 .sort((a, b) => b.bytes - a.bytes)[0]
              || bodies.sort((a, b) => b.bytes - a.bytes)[0];
    if (best) {
        fs.writeFileSync(path.join(__dirname, `capture_${NAME}.txt`), best.text);
        fs.writeFileSync(path.join(__dirname, `capture_${NAME}.json`),
            JSON.stringify({ site: NAME, url: best.url, contentType: best.ct, bytes: best.bytes }, null, 2));
        console.log(`\n✅ saved capture_${NAME}.txt`);
        console.log(`   url : ${best.url}`);
        console.log(`   ct  : ${best.ct}`);
        console.log(`   size: ${best.bytes}`);
        console.log(`   head: ${best.text.split('\n').filter(l => l.trim())[0]?.slice(0, 220)}`);
        // The body is JSON-escaped, so the literal `"calls"` never appears -
        // it is `\"calls\"`. Testing for the bare word avoids a false "no".
        console.log(`   carries payload: ${/calls/.test(best.text) ? 'YES' : 'no'}`);
    } else {
        console.log('\n❌ nothing with a body captured.');
    }
    await browser.close();
})();
