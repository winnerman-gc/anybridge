/**
 * Can the bridge hand a LOCAL image to the chat?
 *
 * Text goes back into the chat as a paste, and that is all `pasteResult` has
 * ever needed. An image cannot travel as text: a chat reads pixels only from an
 * upload, so the userscript has to get a real File into the site's own upload
 * code. Three things had to be measured before writing a `read_image` tool:
 *
 *   1. Which path attaches a File.
 *   2. What "the upload finished" looks like, since the current code clicks
 *      send 500ms after pasting and an upload takes seconds.
 *   3. Whether the model SEES it. The bytes reaching storage prove nothing
 *      about the completions request referencing them.
 *
 * Measured on Qwen, 2026-08-15. A synthetic `paste` carrying a File is enough:
 * the site uploads it and shows a thumbnail, exactly as for a real Ctrl+V. That
 * is the same event `setComposerText` already uses for text, so the userscript
 * needs no new privilege and no site-specific button driving.
 *
 * Two findings that cost a run each, and are why this probe works the way it
 * does:
 *
 *   - **Wait for the composer.** On a half-initialised page the attach control
 *     renders disabled (opacity:0.4;cursor:not-allowed) and EVERY path fails
 *     for that reason alone. The first run of this probe concluded "no
 *     synthetic event attaches a file", which was simply wrong.
 *   - **Reload between paths.** Run back to back they contaminate each other:
 *     an upload started by one lands during the next and is credited to it.
 *     Each path is measured on its own fresh page.
 *
 * The alternates are kept because knowing what does NOT work is worth as much:
 *
 *   drop        works, but every ancestor handles it - dispatching up the chain
 *               uploaded the same file five times, so a drop must go to exactly
 *               one element
 *   fileInput   setting #filesUpload.files and firing change does nothing, even
 *               though that hidden input is what the site's own picker uses
 *   clickPatch  works: patch HTMLInputElement.prototype.click, drive the site's
 *               "+ -> Upload attachment" menu, and feed the File when the click
 *               arrives. More moving parts than paste, and the menu labels are
 *               localised, so it is the fallback rather than the plan.
 *
 * 1. Launch a debuggable Chrome (Chrome 136+ ignores --remote-debugging-port on
 *    the default profile, hence --user-data-dir):
 *
 *      "C:\Program Files\Google\Chrome\Application\chrome.exe" ^
 *        --remote-debugging-port=9222 --user-data-dir="C:/temp/chrome-debug"
 *
 * 2. In that window, log into Qwen.
 * 3. node probes/image_probe_cdp.js
 *
 *   SITE_RE='qwen'   which tab to drive (default qwen)
 *   SEND=0           attach only; do not send a message or spend a turn
 *   ALTERNATES=0     test only the paste path
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
const ALTERNATES = process.env.ALTERNATES !== '0';
const HOME = process.env.SITE_URL || 'https://chat.qwen.ai/';
const OUT = path.join(__dirname, 'image_report.json');
const FILENAME = 'anybridge_probe.png';

// Qwen's composer, measured live 2026-08-15.
const PLUS = '.mode-select-open';                  // attach/mode dropdown trigger
const MENU_ITEM = '.qwen-chat-v2-dropdown-menu-item';
const THUMB = '.file-card-list img.vision-item-image';   // a pending attachment
const ANSWER = '.qwen-chat-message-assistant, .response-message-content';

// ── A PNG, without a dependency ─────────────────────────────
// Node ships zlib, and a solid truecolour image is three chunks. Anything that
// needed an npm install would put a barrier in front of a probe run once.

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

// ── In-page injection ───────────────────────────────────────
// Passed whole to page.evaluate, so it closes over nothing in this file.

function inject({ b64, name, method, menuSel, plusSel }) {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    // A fresh DataTransfer per dispatch: an event may keep the one it was given.
    const mk = () => {
        const dt = new DataTransfer();
        dt.items.add(new File([bytes], name, { type: 'image/png' }));
        return dt;
    };
    const els = document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]');
    let composer = null;
    for (const el of els) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && !el.closest('pre')) composer = el;
    }

    if (method === 'paste') {
        if (!composer) return { error: 'no composer' };
        composer.focus();
        const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: mk() });
        return { consumed: !composer.dispatchEvent(ev), on: composer.tagName };
    }

    if (method === 'drop') {
        // ONE element only. Dispatching up the ancestor chain had every level
        // handle it, and the same file uploaded five times.
        if (!composer) return { error: 'no composer' };
        const target = composer.parentElement || composer;
        const consumed = [];
        for (const type of ['dragenter', 'dragover', 'drop']) {
            const ev = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: mk() });
            if (!target.dispatchEvent(ev)) consumed.push(type);
        }
        return { consumed: consumed.length > 0, phases: consumed, on: target.tagName };
    }

    if (method === 'fileInput') {
        const input = document.querySelector('input[type=file]');
        if (!input) return { error: 'no input[type=file]' };
        input.files = mk().files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        // files drops back to 0 when a handler read them - which happens here,
        // and still uploads nothing.
        return { consumed: input.files.length === 0 };
    }

    if (method === 'clickPatch') {
        const orig = HTMLInputElement.prototype.click;
        window.__bridgeFed = [];
        HTMLInputElement.prototype.click = function () {
            if (this.type !== 'file') return orig.call(this);
            this.files = mk().files;
            window.__bridgeFed.push({ id: this.id, accept: (this.accept || '').length });
            this.dispatchEvent(new Event('change', { bubbles: true }));
        };
        const plus = document.querySelector(plusSel);
        if (!plus) { HTMLInputElement.prototype.click = orig; return { error: 'no attach control' }; }
        plus.click();
        // The menu mounts asynchronously; the patch comes off once it has been
        // used, so an unrelated later click cannot be fed a stale file.
        setTimeout(() => {
            const items = [...document.querySelectorAll(menuSel)];
            const hit = items.find(e => /upload|attach|file/i.test(e.innerText || ''));
            if (hit) hit.click();
            HTMLInputElement.prototype.click = orig;
        }, 900);
        return { consumed: true, deferred: true };
    }

    return { error: 'unknown method ' + method };
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
    const b64 = png.toString('base64');
    console.log(`test image: 256x256 solid ${colour.name}, ${png.length} bytes`);

    // Playwright's network events sit below the page's own JavaScript, so the
    // upload is visible however the site performs it. A PUT of exactly our byte
    // count is the proof the file left the browser.
    let sts = [], puts = [], completionsBody = null;
    page.on('request', req => {
        const url = req.url();
        if (/getstsToken/i.test(url)) sts.push(Date.now());
        if (req.method() === 'PUT' && /aliyuncs\.com/.test(url)) {
            puts.push({ at: Date.now(), bytes: (req.postData() || '').length, url: url.slice(0, 130) });
        }
        if (/chat\/completions/.test(url) && req.method() === 'POST') completionsBody = req.postData();
    });

    // Fresh page, then wait for the composer to be live. Both matter: results
    // from a half-initialised page or from a page another path already dirtied
    // are worse than no results, because they look real.
    async function freshPage() {
        await page.goto(HOME, { waitUntil: 'commit' });
        for (let i = 0; i < 45; i++) {
            await sleep(1000);
            const ok = await page.evaluate(sel => {
                const el = document.querySelector(sel);
                return !!el && !/not-allowed/.test(el.getAttribute('style') || '');
            }, PLUS).catch(() => false);
            if (ok) { await sleep(1200); return true; }
        }
        return false;
    }

    async function attempt(method) {
        if (!await freshPage()) return { method, error: 'the composer never became usable' };
        sts = []; puts = [];
        const t0 = Date.now();
        const seen = await page.evaluate(inject,
            { b64, name: FILENAME, method, menuSel: MENU_ITEM, plusSel: PLUS });
        let thumbAt = 0;
        for (let i = 0; i < 80 && !thumbAt; i++) {
            await sleep(250);
            const there = await page.evaluate(({ sel, name }) =>
                [...document.querySelectorAll(sel)].some(i => (i.alt || '') === name),
            { sel: THUMB, name: FILENAME });
            if (there) thumbAt = Date.now();
        }
        // Give a late duplicate upload time to show up: one attach must be one
        // upload, and a path that fires several is not usable.
        await sleep(2500);
        return {
            method, seen,
            attached: !!thumbAt,
            msToThumbnail: thumbAt ? thumbAt - t0 : null,
            uploads: puts.length,
            stsCalls: sts.length,
            uploadBytes: puts.length ? puts[0].bytes : null,
            msToUpload: puts.length ? puts[0].at - t0 : null,
        };
    }

    const report = {
        when: new Date().toISOString(),
        url: HOME,
        colour: colour.name,
        bytes: png.length,
        selectors: { plus: PLUS, menuItem: MENU_ITEM, thumbnail: THUMB, answer: ANSWER },
        attempts: [],
    };

    const methods = ALTERNATES ? ['paste', 'drop', 'fileInput', 'clickPatch'] : ['paste'];
    for (const m of methods) {
        const a = await attempt(m);
        report.attempts.push(a);
        console.log(`  ${m.padEnd(10)} attached=${String(a.attached).padEnd(5)} ` +
            `uploads=${a.uploads}  thumbnail after ${a.msToThumbnail === null ? '-' : a.msToThumbnail + 'ms'}` +
            (a.error ? '  ' + a.error : ''));
    }

    const paste = report.attempts.find(a => a.method === 'paste');
    report.method = paste && paste.attached && paste.uploads === 1 ? 'paste'
        : (report.attempts.find(a => a.attached && a.uploads === 1) || {}).method || null;

    if (!report.method) {
        report.verdict = 'nothing attached a file - the upload flow has changed, '
            + 'or the tab was not ready';
        fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
        console.log(`\n  ${report.verdict}\n  written to ${OUT}`);
        await browser.close();
        return;
    }
    console.log(`\n  recommended path: ${report.method}`);

    if (!SEND) {
        report.verdict = `attach works via ${report.method}; not sent (SEND=0)`;
        fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
        console.log(`  ${report.verdict}\n  written to ${OUT}`);
        await browser.close();
        return;
    }

    // Attaching is half the question. Whether the model SEES it is the other
    // half, and only its answer proves that. Done on its own fresh page so the
    // turn carries exactly one image.
    await attempt(report.method);
    const question = 'Name the single colour that fills the attached image. Reply with one word only.';
    await page.evaluate(q => {
        const t = document.querySelector('textarea');
        const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        t.focus();
        set.call(t, q);
        t.dispatchEvent(new Event('input', { bubbles: true }));
    }, question);
    await sleep(900);
    await page.evaluate(() => {
        for (const b of document.querySelectorAll('button,[role="button"]')) {
            if (b.disabled) continue;
            const l = ((b.innerText || '') + ' ' + (b.getAttribute('aria-label') || '')).toLowerCase();
            if (/send|submit/.test(l)) { b.click(); return; }
        }
        const t = document.querySelector('textarea');
        if (t) t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
    });
    console.log('  sent; waiting for the answer...');

    let answer = '';
    for (let i = 0; i < 40; i++) {
        await sleep(1500);
        answer = await page.evaluate(sel => {
            const n = [...document.querySelectorAll(sel)];
            const last = n[n.length - 1];
            return last ? (last.innerText || '').slice(-300) : '';
        }, ANSWER);
        if (new RegExp(colour.name, 'i').test(answer)) break;
    }

    // The shape of the answer request is what proves the image is referenced
    // rather than merely stored.
    if (completionsBody) {
        try {
            const j = JSON.parse(completionsBody);
            const msgs = j.messages || [];
            const last = msgs[msgs.length - 1] || {};
            report.model = j.model;
            report.completionsFiles = (last.files || []).map(f => ({
                type: f.type, id: f.id, name: f.file && f.file.name,
                size: f.file && f.file.size, url: String(f.url || '').split('?')[0],
            }));
        } catch { report.completionsRaw = completionsBody.slice(0, 1000); }
    }
    report.answerTail = answer.slice(-200);
    report.modelSawIt = new RegExp(colour.name, 'i').test(answer);
    report.verdict = report.modelSawIt
        ? `a ${report.method} carrying a File attaches and uploads, and the model named `
          + 'the colour - the chat can read a local image'
        : `attached, but the answer never named "${colour.name}" - the file uploaded `
          + 'without reaching the model, or the reply is still coming';

    fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
    console.log(`\n  ${report.verdict}`);
    console.log(`  written to ${OUT}`);
    await browser.close();          // detach only; your Chrome stays open
})();
