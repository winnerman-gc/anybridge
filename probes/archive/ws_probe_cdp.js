/**
 * Kimi answered a prompt without ever making a fetch/XHR request we could see,
 * and the page opens notilo.kimi.com/ws/tickets - so the answer almost
 * certainly arrives over a WebSocket. This hooks WebSocket (and fetch, for
 * comparison) BEFORE page scripts run, then reloads, so the socket is captured
 * from the moment it is created.
 *
 *   node ws_probe_cdp.js
 *
 * Reloads the Kimi tab. Cookies persist, so the login survives.
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require(path.join(
    require('child_process').execSync('npm root -g', { encoding: 'utf8' }).trim(), 'playwright'));

const CDP = process.env.CDP_URL || 'http://127.0.0.1:9222';
const MATCH = process.env.SITE_RE ? new RegExp(process.env.SITE_RE) : /kimi/;
const PROMPT = process.env.PROMPT ||
    'Reply with ONLY the following, inside a ```json code block, and nothing else at all: ' +
    '{"id":"probe_ws","calls":[{"tool":"list","path":"C:/temp"}]}';

function hook() {
    if (window.__wsCap) return;
    const cap = { sockets: [], frames: [] };
    window.__wsCap = cap;
    const OW = window.WebSocket;
    window.WebSocket = function (url, protos) {
        const ws = protos === undefined ? new OW(url) : new OW(url, protos);
        const id = cap.sockets.length;
        cap.sockets.push({ id, url: String(url), opened: Date.now(), sent: 0, recv: 0 });
        ws.addEventListener('message', e => {
            const s = cap.sockets[id];
            s.recv++;
            const d = typeof e.data === 'string' ? e.data : '[binary ' + (e.data.size || e.data.byteLength) + ']';
            cap.frames.push({ id, dir: 'in', t: Date.now(), data: String(d).slice(0, 4000) });
        });
        const os = ws.send;
        ws.send = function (d) {
            cap.sockets[id].sent++;
            cap.frames.push({ id, dir: 'out', t: Date.now(), data: String(d).slice(0, 2000) });
            return os.apply(this, arguments);
        };
        return ws;
    };
    window.WebSocket.prototype = OW.prototype;
    Object.assign(window.WebSocket, OW);
}

(async () => {
    const browser = await chromium.connectOverCDP(CDP);
    const pages = () => browser.contexts().flatMap(c => c.pages());
    const page = pages().find(p => MATCH.test(p.url()));
    if (!page) { console.error('no matching tab for ' + MATCH); process.exit(1); }

    console.log('tab: ' + page.url().slice(0, 90));
    await page.addInitScript(hook);
    console.log('hook armed; reloading so the socket is caught at creation...');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(6000);

    const before = await page.evaluate(() => window.__wsCap ? window.__wsCap.sockets : null);
    console.log('sockets opened on load: ' + JSON.stringify(before, null, 1));

    // Send the prompt.
    let sent = false;
    for (const sel of ['div[contenteditable="true"]', '[role="textbox"]', 'textarea', '.chat-input-editor']) {
        const box = page.locator(sel).last();
        try {
            if (!await box.isVisible({ timeout: 2000 })) continue;
            await box.click(); await box.fill(PROMPT); await page.keyboard.press('Enter');
            sent = true; console.log('prompt sent via ' + sel); break;
        } catch {}
    }
    if (!sent) console.log('COULD NOT SEND - type the prompt yourself now');

    for (let i = 0; i < 30; i++) {
        await page.waitForTimeout(2000);
        const c = await page.evaluate(() => window.__wsCap && ({
            sockets: window.__wsCap.sockets, frames: window.__wsCap.frames.length }));
        if (c && c.frames > 5) break;
        if (i % 5 === 0) console.log(`  ...${i * 2}s frames=${c ? c.frames : '?'}`);
    }

    const cap = await page.evaluate(() => window.__wsCap);
    fs.writeFileSync(path.join(__dirname, 'ws_capture.json'), JSON.stringify(cap, null, 2));
    console.log('\nsockets:');
    for (const s of cap.sockets) console.log(`  [${s.id}] ${s.url}  in=${s.recv} out=${s.sent}`);
    console.log(`\nframes: ${cap.frames.length}  -> ws_capture.json`);
    const inbound = cap.frames.filter(f => f.dir === 'in');
    console.log('\nfirst 3 inbound:');
    inbound.slice(0, 3).forEach(f => console.log('  ' + f.data.slice(0, 300)));
    const hit = inbound.find(f => /"calls"|probe_ws/.test(f.data));
    console.log('\nframe carrying the payload: ' + (hit ? hit.data.slice(0, 400) : 'NONE FOUND'));
    await browser.close();
})();
