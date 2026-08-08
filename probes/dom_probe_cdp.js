/**
 * Same probe as dom_probe.js, but ATTACHES to a Chrome you launched yourself
 * instead of launching its own. Google's OAuth refuses to sign in on an
 * automation-launched browser; here you log in through an ordinary Chrome and
 * Playwright merely connects, so nothing about the login is automated.
 *
 * 1. Close nothing. Launch a debuggable Chrome (Chrome 136+ ignores
 *    --remote-debugging-port on the DEFAULT profile, hence --user-data-dir):
 *
 *      "C:\Program Files\Google\Chrome\Application\chrome.exe" ^
 *        --remote-debugging-port=9222 --user-data-dir="C:/temp/chrome-debug"
 *
 * 2. In that window, log into Qwen and ask for a ```json code block.
 * 3. node dom_probe_cdp.js
 *
 * Your everyday Chrome profile is untouched - the debug window uses its own
 * data dir, so you log into Qwen there once.
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

const CDP = process.env.CDP_URL || 'http://127.0.0.1:9222';
const OUT = path.join(__dirname, 'dom_report.json');
const BASE_SELECTOR = 'pre, code, [data-language], .hljs';
const LEAF_SELECTOR = 'pre, code';
const PAYLOAD_RE_SRC = '["\'](?:calls|commands)["\']\\s*:\\s*\\[';

// Runs in the page. Describes the block exactly as the userscript's scanner
// would see it, so any mismatch shows up as a difference in these fields.
function describe({ base, leaf, reSrc }) {
    const re = new RegExp(reSrc);
    const els = [...document.querySelectorAll(base)];
    const leaves = els.filter(e => !e.querySelector(leaf));
    const target = leaves.filter(e => re.test(e.textContent || '')).pop();
    if (!target) return { error: 'no payload block found on this page' };

    const text = target.textContent || '';
    const codes = {};
    for (const ch of text) {
        const c = ch.charCodeAt(0);
        if (c < 32 || c === 0xA0 || (c >= 0x200B && c <= 0x200D) || c === 0xFEFF)
            codes[c] = (codes[c] || 0) + 1;
    }
    const vis = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };

    return {
        url: location.href,
        selectorMatched: els.length,
        leafCount: leaves.length,
        block: {
            tag: target.tagName,
            className: (target.className || '').toString().slice(0, 140),
            dataLanguage: target.getAttribute('data-language'),
            parentTag: target.parentElement && target.parentElement.tagName,
            childCount: target.children.length,
            childTags: [...target.children].slice(0, 12).map(
                c => c.tagName + (c.className ? '.' + c.className.toString().slice(0, 28) : '')),
        },
        text: {
            length: text.length,
            hasRealNewlines: text.includes('\n'),
            newlineCount: (text.match(/\n/g) || []).length,
            textContentEqualsInnerText: text === (target.innerText || ''),
            innerTextNewlines: ((target.innerText || '').match(/\n/g) || []).length,
            invisibleCharCounts: codes,
            first300: text.slice(0, 300),
        },
        inputs: [...document.querySelectorAll('textarea,[contenteditable="true"],[role="textbox"]')]
            .filter(vis).map(e => ({ tag: e.tagName, contentEditable: e.isContentEditable })),
        sendButtons: [...document.querySelectorAll('button')]
            .map(b => ((b.innerText || '') + ' ' + (b.getAttribute('aria-label') || '')).trim().toLowerCase())
            .filter(l => l && (l.includes('send') || l.includes('submit'))).slice(0, 5),
        shadowHosts: (() => { let n = 0; (function w(e) { for (const c of e.children || []) { if (c.shadowRoot) n++; w(c); } })(document.body); return n; })(),
        outerHTML: target.outerHTML.slice(0, 3000),
    };
}

(async () => {
    let browser;
    try {
        browser = await chromium.connectOverCDP(CDP);
    } catch (e) {
        console.error(`\n  Could not attach to ${CDP}`);
        console.error('  Launch a debuggable Chrome first:\n');
        console.error('    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" \\');
        console.error('      --remote-debugging-port=9222 --user-data-dir="C:/temp/chrome-debug"\n');
        process.exit(1);
    }

    const pages = browser.contexts().flatMap(c => c.pages());
    console.log(`attached; ${pages.length} page(s) open:`);
    for (const p of pages) console.log('  - ' + p.url().slice(0, 90));

    const args = { base: BASE_SELECTOR, leaf: LEAF_SELECTOR, reSrc: PAYLOAD_RE_SRC };

    // Poll every page: whichever one grows a payload block wins.
    let report = null;
    for (let i = 0; i < 300 && !report; i++) {
        for (const p of browser.contexts().flatMap(c => c.pages())) {
            const r = await p.evaluate(describe, args).catch(() => null);
            if (r && !r.error) { report = r; break; }
        }
        if (!report) {
            if (i % 10 === 0) console.log(`  waiting for a json code block... (${i * 2}s)`);
            await new Promise(r => setTimeout(r, 2000));
        }
    }

    if (!report) {
        console.log('\n  No payload block appeared. Ask the model for a ```json block and rerun.');
        await browser.close();          // detaches only; your Chrome stays open
        process.exit(1);
    }

    fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
    console.log('\n' + JSON.stringify(report, null, 2));
    console.log(`\n  Written to ${OUT}`);
    await browser.close();              // detach, do not kill your browser
})();
