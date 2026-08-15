// The image path: a read_image result must put a real File in the composer
// BEFORE the text is pasted and sent, and must say so plainly when it cannot.
//
// Both failure modes here are silent ones, which is why they are worth a suite:
// sending before the upload lands produces a message with no image and no
// error, and a model told "the image is attached" while looking at a message
// without one will simply invent what it saw.
//
//   BRIDGE_TEST_URL=https://chatgpt.com/c/abc  node tests/test_image.js
//
// runs the same file against a site with no measured attach path, where the
// right behaviour is to fetch nothing and say the picture is not there.
const fs = require('fs');
const path = require('path');
const SRC = process.env.BRIDGE_SRC || path.join(__dirname, '..', 'userscript', 'bridge.user.js');
const src = fs.readFileSync(SRC, 'utf8');

const URL = process.env.BRIDGE_TEST_URL || 'https://chat.qwen.ai/c/abc123';
const HOST = URL.split('/')[2];
const IS_QWEN = /qwen/.test(HOST);
// The container each site renders assistant messages into, so the payload block
// passes the authorship test.
const ANSWER_CLASS = IS_QWEN ? 'qwen-chat-message-assistant' : null;
const ANSWER_ATTR = IS_QWEN ? null : ['data-message-author-role', 'assistant'];

let P = 0, F = 0;
function ck(name, cond, extra) {
    console.log((cond ? '  PASS  ' : '  FAIL  ') + name);
    if (!cond && extra !== undefined) console.log('        ' + extra);
    P += !!cond; F += !cond;
}

// ---- virtual clock --------------------------------------------------------
// The attach path polls for up to a minute of wall time. Collapsing setTimeout
// to zero without moving the clock would hang the "it never arrives" test for
// that whole minute; advancing the clock by the delay asked for makes it
// instant and still exercises the real timeout arithmetic.
let clock = 1e6;
const realSetTimeout = setTimeout;
global.setTimeout = (fn, ms) => { clock += (ms || 0); return realSetTimeout(fn, 0); };
// The scan ticker, kept so a tick can be driven by hand.
const tickFns = [];
global.setInterval = (fn, ms) => { if (ms === 1500) tickFns.push(fn); return 0; };
const RealDate = Date;
global.Date = class extends RealDate { static now() { return clock; } };

// ---- minimal DOM ----------------------------------------------------------
const log = [];            // the order things happened in - the real assertion
let thumbs = [];           // what the site is showing as attached
let thumbPolls = 3;        // polls before an attachment shows; null = never
let pending = null;

class El {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this._text = ''; this.attrs = {}; }
    set textContent(v) { this._text = v; }
    get textContent() { return this.children.length ? this.children.map(c => c.textContent).join('') : this._text; }
    append(c) { c.parent = this; this.children.push(c); return c; }
    attr(k, v) { this.attrs[k] = v; return this; }
    matches(sel) {
        return sel.split(',').map(s => s.trim()).filter(Boolean).some(one => {
            // Only the LAST simple selector has to match this element; any
            // ancestor may satisfy the rest, which is enough for the descendant
            // selectors the adapters use.
            const parts = one.split(/\s+/);
            if (!this._simple(parts[parts.length - 1])) return false;
            for (let i = parts.length - 2; i >= 0; i--) {
                let n = this.parent, found = false;
                for (; n; n = n.parent) if (n._simple && n._simple(parts[i])) { found = true; break; }
                if (!found) return false;
            }
            return true;
        });
    }
    _simple(one) {
        if (one.startsWith('.')) return (this.className || '').split(/\s+/).includes(one.slice(1));
        if (one.startsWith('#')) return this.attrs.id === one.slice(1);
        const m = /^\[([a-zA-Z0-9_-]+)(?:=(?:"([^"]*)"))?\]$/.exec(one);
        if (m) {
            const have = this.attrs[m[1]];
            if (have === undefined) return false;
            return m[2] === undefined || have === m[2];
        }
        return this.tagName === one.toUpperCase();
    }
    closest(sel) { for (let n = this; n; n = n.parent) if (n.matches && n.matches(sel)) return n; return null; }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
    querySelectorAll(sel) {
        const out = [];
        (function walk(n) { for (const c of n.children) { if (c.matches(sel)) out.push(c); walk(c); } })(this);
        return out;
    }
    getBoundingClientRect() { return { width: 100, height: 20 }; }
    getAttribute(k) { return this.attrs[k] || ''; }
    focus() {}
    addEventListener() {}
    dispatchEvent(ev) {
        // A paste carrying a File is the attach; a paste carrying text is the
        // result. Both arrive here, and the order between them is the point.
        const dt = ev.clipboardData;
        if (dt && dt.files && dt.files.length) {
            const f = dt.files[0];
            log.push('image-paste:' + f.name + ':' + f.type);
            // The site takes a few polls to show the thumbnail, as the real one
            // takes seconds. Counted in polls rather than milliseconds so the
            // test cannot race the virtual clock.
            if (thumbPolls !== null) pending = { name: f.name, left: thumbPolls };
        }
        return true;
    }
}

const root = new El('div');
const composer = new El('textarea');
composer.attrs.id = 'prompt-textarea';
Object.defineProperty(composer, 'value', {
    get() { return this._v || ''; },
    set(v) { if (v) log.push('text'); this._v = v; },
});
root.append(composer);

const sendButton = new El('button');
sendButton.attrs['aria-label'] = 'Send message';
sendButton.innerText = 'Send';
sendButton.click = () => log.push('send');
root.append(sendButton);

global.document = {
    documentElement: root,
    querySelectorAll(sel) {
        // The site's attachment thumbnails live outside this fake tree, so the
        // adapter's selector is answered from the list the test controls.
        if (/vision-item-image/.test(sel)) {
            if (pending && --pending.left <= 0) {
                thumbs.push({ alt: pending.name });
                log.push('thumb');
                pending = null;
            }
            return thumbs;
        }
        return root.querySelectorAll(sel);
    },
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
    addEventListener() {}, removeEventListener() {}, execCommand() {},
};
global.window = {
    HTMLTextAreaElement: { prototype: {} },
    location: { href: URL },
    navigator: {},
    Uint8Array,
    File: class { constructor(parts, name, opts) { this.parts = parts; this.name = name; this.type = (opts || {}).type; } },
    DataTransfer: class {
        constructor() { this.files = []; this.items = { add: f => this.files.push(f) }; }
        setData() {}
    },
    ClipboardEvent: class { constructor(t, init) { this.type = t; this.clipboardData = (init || {}).clipboardData; } },
};
global.location = window.location;
global.Event = class { constructor(t) { this.type = t; } };
global.KeyboardEvent = class { constructor(t) { this.type = t; } };
global.ClipboardEvent = window.ClipboardEvent;
global.DataTransfer = window.DataTransfer;
// The script only rescans when the DOM changed, and it learns that from
// here - without this the second batch of a run is never looked at.
global.MutationObserver = class { constructor(cb) { global.__mo = cb; } observe() {} };
global.GM_registerMenuCommand = () => {};

const store = new Map([['bridge_token', 'tok-1'], ['bridge_hosts', [HOST]]]);
global.GM_getValue = (k, d) => (store.has(k) ? store.get(k) : d);
global.GM_setValue = (k, v) => store.set(k, v);
global.GM_listValues = () => [...store.keys()];
global.GM_deleteValue = k => store.delete(k);

// ---- fake agent -----------------------------------------------------------
const PNG = Buffer.from('89504e470d0a1a0a', 'hex');       // signature is enough here
const imageRequests = [];
let batchResults = null;
let serveImage = () => ({ status: 200, response: PNG.buffer.slice(0) });

global.GM_xmlhttpRequest = (opts) => {
    const url = String(opts.url || '');
    const done = res => setTimeout(() => opts.onload(res), 0);
    if (/\/image\?/.test(url)) {
        imageRequests.push({ url, responseType: opts.responseType,
                             token: (opts.headers || {})['X-Anybridge-Token'] });
        return done(serveImage());
    }
    if ((opts.method || 'POST').toUpperCase() === 'GET') {
        return done({ status: 200, responseText: JSON.stringify({ prompt: 'x' }) });
    }
    return done({ status: 200, responseText: JSON.stringify(batchResults) });
};

eval(src);

// ---- driving one batch ----------------------------------------------------
// Through the DOM scanner, so the whole real path runs: scan, POST, attach,
// paste, send.
let blockN = 0;
function emitPayload() {
    const turn = root.append(new El('div'));
    if (ANSWER_CLASS) turn.className = ANSWER_CLASS;
    if (ANSWER_ATTR) turn.attr(ANSWER_ATTR[0], ANSWER_ATTR[1]);
    const pre = turn.append(new El('pre'));
    pre.textContent = JSON.stringify(
        { id: 'img_' + (++blockN), calls: [{ tool: 'read_image', path: 'C:/w/shot.png' }] });
    return pre;
}

const sleep = async (n = 40) => { for (let i = 0; i < n; i++) await new Promise(r => realSetTimeout(r, 1)); };

async function runBatchWith(results, polls) {
    log.length = 0;
    imageRequests.length = 0;
    thumbs = [];
    pending = null;
    thumbPolls = polls;
    composer.value = '';
    log.length = 0;                       // the reset above logs a 'text'
    batchResults = { results, render: '=== BRIDGE RESULT (1 call) ===\n[1] read_image  C:/w/shot.png  ok' };
    emitPayload();
    if (global.__mo) global.__mo();
    // Two ticks: a block must read identical twice before it runs.
    tickFns.forEach(f => f());
    await sleep(4);
    tickFns.forEach(f => f());
    // Wait for THIS batch to land rather than for a fixed time. Batches queue,
    // so a fixed wait lets one scenario be judged on the previous one's result -
    // which passes, and proves nothing.
    for (let i = 0; i < 4000 && !composer.value; i++) {
        await sleep(1);
        tickFns.forEach(f => f());
    }
    await sleep(30);
}

const OK_RESULT = { ok: true, tool: 'read_image', path: 'C:/w/shot.png',
                    name: 'shot.png', mime: 'image/png', format: 'png', size: 8 };

(async () => {
    if (IS_QWEN) {
        console.log('== qwen: a measured attach path ==');
        await runBatchWith([OK_RESULT], 3);

        ck('the bytes are fetched from the agent, not carried in the result',
           imageRequests.length === 1, JSON.stringify(imageRequests));
        ck('...for the path the tool named',
           /path=C%3A%2Fw%2Fshot\.png/.test(imageRequests[0].url), imageRequests[0].url);
        ck('...as binary, since a File cannot be built from text',
           imageRequests[0].responseType === 'arraybuffer', imageRequests[0].responseType);
        ck('...carrying this run\'s token like every other call',
           imageRequests[0].token === 'tok-1', imageRequests[0].token);

        ck('a File reaches the composer with its name and type',
           log.includes('image-paste:shot.png:image/png'), log.join(' > '));

        const iImg = log.indexOf('image-paste:shot.png:image/png');
        const iThumb = log.indexOf('thumb');
        const iText = log.indexOf('text');
        const iSend = log.indexOf('send');
        ck('the image is pasted before the results text', iImg < iText, log.join(' > '));
        // The whole reason this suite exists: the upload takes seconds, and
        // sending first loses the picture with no error anywhere.
        ck('nothing is sent until the site shows the attachment',
           iThumb > -1 && iThumb < iText && iThumb < iSend, log.join(' > '));
        ck('the text is pasted, then sent', iText > -1 && iSend > iText, log.join(' > '));

        console.log('\n== qwen: the upload never lands ==');
        await runBatchWith([OK_RESULT], null);
        ck('it gives up rather than waiting forever', log.includes('text'), log.join(' > '));
        ck('...and still pastes the results', log.indexOf('send') > log.indexOf('text'), log.join(' > '));
        ck('...and says the picture is NOT there',
           /could NOT attach/.test(composer.value), composer.value.slice(-200));

        console.log('\n== qwen: the agent will not serve the bytes ==');
        serveImage = () => ({ status: 404, responseText: '{}' });
        await runBatchWith([OK_RESULT], 3);
        ck('a refused fetch is reported, not swallowed',
           /could NOT attach/.test(composer.value), composer.value.slice(-200));
        ck('...and no File was pasted',
           !log.some(l => l.startsWith('image-paste')), log.join(' > '));
        serveImage = () => ({ status: 200, response: PNG.buffer.slice(0) });

        console.log('\n== qwen: more images than one message should carry ==');
        const many = [];
        for (let i = 0; i < 6; i++) many.push(Object.assign({}, OK_RESULT));
        await runBatchWith(many, 3);
        ck('only the first few are attached',
           log.filter(l => l.startsWith('image-paste')).length === 4,
           log.filter(l => l.startsWith('image-paste')).length);
        ck('...and the message says the rest were left out',
           /first 4 of 6 images/.test(composer.value), composer.value.slice(-200));
    } else {
        console.log('== a site with no measured attach path ==');
        await runBatchWith([OK_RESULT], null);
        ck('no bytes are fetched at all', imageRequests.length === 0, imageRequests.length);
        ck('nothing is pasted as a File',
           !log.some(l => l.startsWith('image-paste')), log.join(' > '));
        // Silence here would leave the model describing a picture it cannot see.
        ck('the message says the picture is not in it',
           /cannot be attached/.test(composer.value), composer.value.slice(-200));
        ck('the results themselves still arrive',
           log.indexOf('text') > -1 && log.indexOf('send') > log.indexOf('text'), log.join(' > '));
    }

    // Let any last warning from the script land BEFORE the summary: run_all
    // echoes the final line of each suite, and a stray line after it hides the
    // result.
    await sleep(20);
    console.log(`\n${F ? 'FAILURES' : 'ALL PASS'}: ${P} passed, ${F} failed`);
    process.exit(F ? 1 : 0);
})();
