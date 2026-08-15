/**
 * Can the bridge hand a LOCAL image to the chat?
 *
 * Text goes back into the chat as a paste, and that is all `pasteResult` has
 * ever needed. An image cannot travel that way: a chat reads pixels only from
 * an upload, so the userscript would have to put a real File into the composer
 * and let the site's own upload path carry it. Three things have to be true
 * before writing a `read_image` tool, and none of them can be assumed:
 *
 *   1. Which synthetic event actually attaches a File - paste, drop, or setting
 *      input[type=file].files. Sites implement one, two or none of these.
 *   2. What "the upload finished" looks like in the DOM. The current code
 *      clicks send 500ms after pasting; an upload takes seconds, and sending
 *      early sends a message with no image.
 *   3. Whether the model actually SEES it. The image reaching the server proves
 *      nothing about the completions request referencing it.
 *
 * This probe answers all three, and records the upload traffic on the way past.
 *
 * 1. Launch a debuggable Chrome (Chrome 136+ ignores --remote-debugging-port on
 *    the default profile, hence --user-data-dir):
 *
 *      "C:\Program Files\Google\Chrome\Application\chrome.exe" ^
 *        --remote-debugging-port=9222 --user-data-dir="C:/temp/chrome-debug"
 *
 * 2. In that window, log into Qwen and open a chat with an empty composer.
 * 3. node probes/image_probe_cdp.js
 *
 *   SITE_RE='qwen'   which tab to drive (default qwen)
 *   SEND=0           attach only; do not send a message or spend a turn
 *
 * The test image is generated here, not read from disk: a solid square in a
 * colour picked at random per run. Random because the verdict is "the model
 * named this colour", and a fixed colour could be satisfied by a stale answer
 * still on the page from an earlier attempt.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

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

const CDP = process.env.CDP_URL || 'http://127.0.0.1:9222';
const MATCH = new RegExp(process.env.SITE_RE || 'qwen');
const SEND = process.env.SEND !== '0';
const OUT = path.join(__dirname, 'image_report.json');
const FILENAME = 'anybridge_probe.png';

// ── A PNG, without a dependency ─────────────────────────────
// Node ships zlib, and a solid truecolour image is three chunks. Anything that
// needs an npm install would put a barrier in front of a probe people run once.

function crc32(buf) {
    let table = crc32.t;
    if (!table) {
        table = crc32.t = new Int32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
            table[n] = c;
        }
    }
    let crc = -1;
    for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xFF];
    return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([len, body, crc]);
}

function solidPng(w, h, rgb) {
    const stride = 1 + w * 3;                      // one filter byte per scanline
    const raw = Buffer.alloc(h * stride);
    for (let y = 0; y < h; y++) {
        const off = y * stride;
        raw[off] = 0;                              // filter type 0: none
        for (let x = 0; x < w; x++) {
            raw[off + 1 + x * 3] = rgb[0];
            raw[off + 2 + x * 3] = rgb[1];
            raw[off + 3 + x * 3] = rgb[2];
        }
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0);
    ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8;                                   // bit depth
    ihdr[9] = 2;                                   // colour type 2: truecolour
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
        chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(raw)),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

const COLOURS = [
    { name: 'red', rgb: [220, 20, 20] },
    { name: 'green', rgb: [20, 170, 60] },
    { name: 'blue', rgb: [30, 60, 220] },
    { name: 'yellow', rgb: [245, 215, 20] },
    { name: 'purple', rgb: [130, 40, 180] },
    { name: 'orange', rgb: [240, 130, 20] },
];

// ── In-page helpers ─────────────────────────────────────────
// Each of these is passed whole to page.evaluate, so they may not close over
// anything in this file.

// Same rule the userscript uses: the last visible editable box, ignoring
// anything inside a code block.
function findComposerSrc() {
    return function () {
        const els = document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]');
        let target = null;
        for (const el of els) {
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0 && !el.closest('pre')) target = el;
        }
        return target;
    };
}

// What the page looks like, in the terms an attachment would change. The class
// census is the part that matters: diffing it before and after names the
// element the site renders for a pending attachment, which is what the
// userscript will have to wait on before it clicks send.
function census(filename) {
    const classes = {};
    for (const el of document.querySelectorAll('*')) {
        const cn = el.className;
        const s = typeof cn === 'string' ? cn : (cn && cn.baseVal) || '';
        for (const c of s.trim().split(/\s+/)) if (c) classes[c] = (classes[c] || 0) + 1;
    }
    const imgs = [...document.querySelectorAll('img')];
    const buttons = [...document.querySelectorAll('button')].filter(b => {
        const r = b.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
    });
    return {
        classes,
        elements: document.querySelectorAll('*').length,
        images: imgs.length,
        blobImages: imgs.filter(i => /^(blob:|data:)/.test(i.src || '')).length,
        filenameOnPage: (document.body.innerText || '').includes(filename),
        fileInputs: [...document.querySelectorAll('input[type=file]')].map(i => ({
            accept: i.accept || '', multiple: !!i.multiple, files: i.files ? i.files.length : -1,
        })),
        enabledSendButtons: buttons.filter(b => !b.disabled && /send|submit/i.test(
            (b.innerText || '') + ' ' + (b.getAttribute('aria-label') || ''))).length,
        disabledButtons: buttons.filter(b => b.disabled).length,
    };
}

// Build the File in the page and offer it three ways. Each method is tried on
// its own so the report can say which one the site implements - a probe that
// fired all three at once would prove only that at least one works.
function inject({ b64, name, method }) {
    const els = document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]');
    let composer = null;
    for (const el of els) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && !el.closest('pre')) composer = el;
    }
    if (!composer && method !== 'fileInput') return { error: 'no composer found' };

    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const file = new File([bytes], name, { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);

    if (method === 'paste') {
        composer.focus();
        const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
        // preventDefault means the editor handled it. Reported, not trusted:
        // an editor can consume a paste and still ignore the file part.
        const consumed = !composer.dispatchEvent(ev);
        return { method, dispatched: true, consumed, on: composer.tagName };
    }

    if (method === 'drop') {
        // The drop target is rarely the text box itself - it is usually the
        // panel around it - so walk up a few levels and give each the full
        // dragenter/dragover/drop sequence a real drag produces.
        const targets = [];
        let el = composer;
        for (let i = 0; i < 5 && el; i++) { targets.push(el); el = el.parentElement; }
        targets.push(document.body);
        const results = [];
        for (const t of targets) {
            for (const type of ['dragenter', 'dragover', 'drop']) {
                const ev = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt });
                results.push({ type, tag: t.tagName, consumed: !t.dispatchEvent(ev) });
            }
        }
        return { method, dispatched: true, sequence: results.filter(r => r.consumed) };
    }

    if (method === 'fileInput') {
        const inputs = [...document.querySelectorAll('input[type=file]')];
        // An accept list naming images is the upload control; a site may also
        // have a document-only one, and feeding a PNG to that proves nothing.
        const input = inputs.find(i => /image|png|\*/i.test(i.accept || '')) || inputs[0];
        if (!input) return { error: 'no input[type=file] on the page' };
        input.files = dt.files;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return { method, dispatched: true, accept: input.accept || '', took: input.files.length };
    }

    return { error: 'unknown method ' + method };
}

// Classes that appeared, or grew, between two censuses. This is the answer to
// "what selector says an attachment is pending".
function diffClasses(before, after) {
    const out = [];
    for (const [k, n] of Object.entries(after.classes)) {
        const was = before.classes[k] || 0;
        if (n > was) out.push({ class: k, was, now: n });
    }
    return out.sort((a, b) => (b.now - b.was) - (a.now - a.was)).slice(0, 40);
}

function attached(before, after) {
    return after.blobImages > before.blobImages
        || after.images > before.images
        || (after.filenameOnPage && !before.filenameOnPage);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
    let browser;
    try {
        browser = await chromium.connectOverCDP(CDP);
    } catch {
        console.error(`\n  Could not attach to ${CDP}`);
        console.error('  Launch a debuggable Chrome first:\n');
        console.error('    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" \\');
        console.error('      --remote-debugging-port=9222 --user-data-dir="C:/temp/chrome-debug"\n');
        process.exit(1);
    }

    const page = browser.contexts().flatMap(c => c.pages()).find(p => MATCH.test(p.url()));
    if (!page) {
        console.error('no tab matching ' + MATCH);
        await browser.close();
        process.exit(1);
    }
    console.log('tab: ' + page.url().slice(0, 90));

    const colour = COLOURS[Math.floor(Math.random() * COLOURS.length)];
    const png = solidPng(256, 256, colour.rgb);
    console.log(`test image: 256x256 solid ${colour.name}, ${png.length} bytes`);

    // Playwright's network events sit below the page's own JavaScript, so an
    // upload is visible however the site performs it - fetch, XHR, or a form.
    const traffic = [];
    let completionsBody = null;
    page.on('request', req => {
        const url = req.url();
        if (/\.(css|woff2?|ico|map|svg)(\?|$)/i.test(url)) return;
        const m = req.method();
        if (m === 'GET' && !/upload|file|oss|sts|image/i.test(url)) return;
        traffic.push({ t: Date.now(), method: m, url: url.slice(0, 200), size: (req.postData() || '').length });
        if (/chat\/completions/.test(url) && m === 'POST') completionsBody = req.postData();
    });
    page.on('response', res => {
        const url = res.url();
        if (!/upload|file|oss|sts|image/i.test(url)) return;
        traffic.push({ t: Date.now(), status: res.status(), url: url.slice(0, 200) });
    });

    const report = {
        when: new Date().toISOString(),
        url: page.url(),
        colour: colour.name,
        bytes: png.length,
        attempts: [],
    };

    const b64 = png.toString('base64');
    let winner = null;

    for (const method of ['paste', 'drop', 'fileInput']) {
        console.log(`\n  trying ${method}...`);
        const before = await page.evaluate(census, FILENAME);
        const injected = await page.evaluate(inject, { b64, name: FILENAME, method });
        // Uploads are not instant and a thumbnail often waits on the response.
        await sleep(4000);
        const after = await page.evaluate(census, FILENAME);

        const attempt = {
            method,
            injected,
            attached: attached(before, after),
            images: [before.images, after.images],
            blobImages: [before.blobImages, after.blobImages],
            filenameOnPage: after.filenameOnPage,
            newClasses: diffClasses(before, after),
            fileInputs: after.fileInputs,
            enabledSendButtons: [before.enabledSendButtons, after.enabledSendButtons],
        };
        report.attempts.push(attempt);
        console.log(`    attached: ${attempt.attached}` +
            (attempt.injected && attempt.injected.error ? `  (${attempt.injected.error})` : ''));
        if (attempt.attached) { winner = method; break; }
    }

    report.method = winner;

    if (!winner) {
        report.verdict = 'no synthetic event attached a file - the composer takes '
            + 'uploads through a path this probe did not reach';
        fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
        console.log('\n  ' + report.verdict);
        console.log(`  written to ${OUT}`);
        await browser.close();
        return;
    }

    console.log(`\n  attached via ${winner}`);

    // Settle: wait for the upload traffic to go quiet, so the timing the
    // userscript needs is measured rather than guessed.
    const t0 = Date.now();
    let lastCount = traffic.length;
    let quietSince = Date.now();
    while (Date.now() - t0 < 30000) {
        await sleep(500);
        if (traffic.length !== lastCount) { lastCount = traffic.length; quietSince = Date.now(); }
        else if (Date.now() - quietSince > 3000) break;
    }
    report.settleMs = Date.now() - t0;
    report.traffic = traffic.slice(-40);
    console.log(`  upload traffic settled after ${report.settleMs}ms, ${traffic.length} request(s)`);

    if (!SEND) {
        report.verdict = `attach works via ${winner}; not sent (SEND=0)`;
        fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
        console.log(`\n  ${report.verdict}\n  written to ${OUT}`);
        await browser.close();
        return;
    }

    // Attaching is half the question. Whether the model can SEE it is the other
    // half, and only the answer proves that.
    const question = 'Name the single colour that fills this image. Reply with one word only.';
    await page.evaluate(q => {
        const els = document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]');
        let t = null;
        for (const el of els) {
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0 && !el.closest('pre')) t = el;
        }
        if (!t) return;
        t.focus();
        const dt = new DataTransfer();
        dt.setData('text/plain', q);
        const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
        if (!t.dispatchEvent(ev)) return;
        document.execCommand('insertText', false, q);
    }, question);
    await sleep(600);
    await page.evaluate(() => {
        for (const b of document.querySelectorAll('button')) {
            if (b.disabled) continue;
            const label = ((b.innerText || '') + ' ' + (b.getAttribute('aria-label') || '')).toLowerCase();
            if (label.includes('send') || label.includes('submit')) { b.click(); return; }
        }
        const els = document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]');
        const t = els[els.length - 1];
        if (t) t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
    });
    console.log('  sent; waiting for the answer...');

    const ANSWER = '.qwen-chat-message-assistant, .response-message-content';
    let answer = '';
    for (let i = 0; i < 60; i++) {
        await sleep(1500);
        answer = await page.evaluate(sel => {
            const nodes = [...document.querySelectorAll(sel)];
            const last = nodes[nodes.length - 1];
            return last ? (last.innerText || '').slice(-400) : '';
        }, ANSWER);
        if (new RegExp(colour.name, 'i').test(answer)) break;
    }

    report.completionsRequest = completionsBody ? completionsBody.slice(0, 4000) : null;
    report.answerTail = answer;
    report.modelSawIt = new RegExp(colour.name, 'i').test(answer);
    report.verdict = report.modelSawIt
        ? `attach via ${winner}; the model named the colour - the model can read a local image`
        : `attach via ${winner}, but the answer never named "${colour.name}" - `
          + 'the file uploaded without reaching the model, or the reply is still coming';

    fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
    console.log(`\n  ${report.verdict}`);
    console.log(`  written to ${OUT}`);
    await browser.close();          // detach only; your Chrome stays open
})();
