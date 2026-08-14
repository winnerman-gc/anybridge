// Diagnostic benchmark: how the harness's DOM scan cost scales with conversation
// size. Drives the REAL userscript at document-start on a mocked page; block text
// is payload-free prose (common case), so this isolates collectCandidates() + the
// cheap reject gates that every scan pays on a loaded chat.
const fs = require('fs');
const SRC = process.env.BRIDGE_SRC || require('path').join(__dirname, '..', 'userscript', 'bridge.user.js');
const src = fs.readFileSync(SRC, 'utf8');

let idc = 0;
class El {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this._text = ''; this.id = ++idc; }
    set textContent(v) { this._text = v; }
    get textContent() { return this.children.length ? this.children.map(c => c.textContent).join('') : this._text; }
    append(c) { c.parent = this; this.children.push(c); return c; }
    setAttr(name, value) { (this.attrs || (this.attrs = {}))[name] = value; return this; }
    matches(sel) {
        return sel.split(',').map(s => s.trim()).filter(Boolean).some(one => {
            if (one.startsWith('.')) return (this.className || '').split(/\s+/).includes(one.slice(1));
            const m = /^\[([a-zA-Z0-9_-]+)(?:([*^$]?)=(?:"([^"]*)"|'([^']*)'))?\s*(i)?\]$/.exec(one);
            if (m) {
                const name = m[1], want = m[3] !== undefined ? m[3] : m[4];
                let have = (this.attrs || {})[name];
                if (have === undefined && name === 'class') have = this.className;
                if (have === undefined) return false;
                if (want === undefined) return true;
                const a = m[5] ? String(have).toLowerCase() : String(have);
                const b = m[5] ? want.toLowerCase() : want;
                return m[2] === '*' ? a.includes(b) : m[2] === '^' ? a.startsWith(b)
                    : m[2] === '$' ? a.endsWith(b) : a === b;
            }
            return this.tagName === one.toUpperCase();
        });
    }
    closest(sel) { for (let n = this; n; n = n.parent) if (n.matches && n.matches(sel)) return n; return null; }
    querySelectorAll(sel) {
        const out = [];
        if (sel.startsWith('.')) {
            const cls = sel.slice(1);
            (function walk(n) { for (const c of n.children) {
                if ((c.className || '').split(' ').includes(cls)) out.push(c); walk(c); } })(this);
        }
        return out;
    }
    querySelector(sel) {
        if (sel.startsWith('.')) {
            const cls = sel.slice(1);
            const st = [...this.children];
            while (st.length) { const c = st.pop(); if ((c.className || '').split(' ').includes(cls)) return c; st.push(...c.children); }
            return null;
        }
        const want = sel.split(',').map(s => s.trim().toUpperCase());
        const st = [...this.children];
        while (st.length) { const c = st.pop(); if (want.includes(c.tagName)) return c; st.push(...c.children); }
        return null;
    }
    getBoundingClientRect() { return { width: 100, height: 20 }; }
    focus() {} addEventListener() {} dispatchEvent() {}
    click() { if (this.onclick) this.onclick(); }
    getAttribute() { return ''; }
}

function buildDOM(turns) {
    const root = new El('div');
    const textarea = new El('textarea'); textarea.textContent = ''; root.append(textarea);
    for (let t = 0; t < turns; t++) {
        const turn = root.append(new El('div'));
        turn.className = 'markdown prose';
        turn.setAttr('data-message-author-role', 'assistant');
        const pre = turn.append(new El('pre'));
        const code = pre.append(new El('code'));
        code.textContent = 'plain prose here with no payload marker ' + t;
    }
    return root;
}

function run(sizeTurns, ticks) {
    idc = 0;
    const root = buildDOM(sizeTurns);
    const intervalCbs = [];
    const allEls = () => { const out = []; (function walk(n){ for (const c of n.children){ out.push(c); walk(c);} })(root); return out; };

    global.document = {
        documentElement: root,
        querySelectorAll(sel) {
            const want = sel.split(',').map(s => s.trim().toUpperCase());
            return allEls().filter(e => want.includes(e.tagName));
        },
        addEventListener() {}, removeEventListener() {}, execCommand() {},
    };
    global.window = {
        fetch: async () => { throw new Error('no network in bench'); },
        XMLHttpRequest: undefined,
        HTMLTextAreaElement: { prototype: {} },
        navigator: { clipboard: { writeText: async () => {} } },
        location: { href: 'https://chatgpt.com/c/abc123', hostname: 'chatgpt.com' },
    };
    global.unsafeWindow = global.window;
    global.location = global.window.location;
    global.Event = class { constructor(t) { this.type = t; } };
    global.KeyboardEvent = class { constructor(t) { this.type = t; } };
    global.MutationObserver = class { constructor(cb) { global.__mo = cb; } observe() {} };
    global.setInterval = cb => { intervalCbs.push(cb); return intervalCbs.length; };
    global.clearInterval = () => {};
    global.setTimeout = () => 0;
    global.TextDecoder = TextDecoder;

    const store = new Map();
    global.GM_getValue = (k, d) => store.has(k) ? store.get(k) : d;
    global.GM_setValue = (k, v) => store.set(k, v);
    global.GM_listValues = () => [...store.keys()];
    global.GM_deleteValue = k => store.delete(k);
    global.GM_registerMenuCommand = () => {};
    global.GM_xmlhttpRequest = o => { setTimeout(() => o.onload({ responseText: '{"results":[]}' }), 0); };

    const realLog = console.log; console.log = () => {};
    eval(src); console.log = realLog;

    const scanTick = intervalCbs.find(cb => cb.toString().includes('scanAndExecute')) || intervalCbs[0];
    if (!scanTick) throw new Error('scan interval not captured');

    global.__mo(); scanTick();
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < ticks; i++) { global.__mo(); scanTick(); }
    const dt = Number(process.hrtime.bigint() - t0) / 1e6;
    return { dt, perTick: dt / ticks };
}

console.log('DOM-scan cost vs conversation size (synchronous ticks):');
console.log('  turns   matches   10-tick total   per tick');
for (const turns of [50, 250, 1000, 3000, 6000]) {
    const r = run(turns, 10);
    console.log('  ' + String(turns).padStart(5) + '  ' + String(turns * 2).padStart(7)
        + '   ' + r.dt.toFixed(1).padStart(11) + ' ms   ' + r.perTick.toFixed(2).padStart(8) + ' ms');
}
process.exit(0);
