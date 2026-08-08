/**
 * Inspects the real chat DOM so the userscript's assumptions stop being guesses.
 *
 * Uses its own browser profile under the scratchpad - your everyday Chrome
 * profile and its cookies are never opened. You log into Qwen in the window it
 * opens; nothing here handles credentials.
 *
 *   node dom_probe.js
 *
 * Then: log in, send any prompt that makes the model emit a ```json code block,
 * and the probe dumps what the scanner needs to know.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

// Playwright is installed globally (npm i -g playwright), and node does not
// search the global root when resolving require(). Fall back to it explicitly
// so this runs from any directory without a per-project install.
function loadPlaywright() {
    try { return require('playwright'); } catch {}
    try {
        const root = require('child_process')
            .execSync('npm root -g', { encoding: 'utf8' }).trim();
        return require(path.join(root, 'playwright'));
    } catch (e) {
        console.error('playwright not found. Install it with:  npm install -g playwright');
        process.exit(1);
    }
}
const { chromium } = loadPlaywright();

// A throwaway browser profile, so your real one and its cookies are never
// opened. Override with PROBE_PROFILE to keep a login between runs.
const PROFILE = process.env.PROBE_PROFILE ||
    path.join(os.tmpdir(), 'anybridge-probe-profile');
const OUT = path.join(__dirname, 'dom_report.json');
const URL = process.env.PROBE_URL || 'https://chat.qwen.ai/';

// Mirrors the userscript's constants; if these drift, the probe lies.
const BASE_SELECTOR = 'pre, code, [data-language], .hljs';
const LEAF_SELECTOR = 'pre, code';

(async () => {
    const ctx = await chromium.launchPersistentContext(PROFILE, {
        headless: process.env.PROBE_HEADLESS === '1',
        viewport: null,
        args: ['--start-maximized'],
    });
    const page = ctx.pages()[0] || await ctx.newPage();
    await page.goto(URL);

    console.log('\n  Log in, then ask the model for a JSON code block.');
    console.log('  Probe is watching; it reports as soon as one appears.\n');

    // Poll for a code block whose text looks like a payload.
    const found = await page.waitForFunction((sel) => {
        const els = [...document.querySelectorAll(sel)];
        return els.some(e => /["'](?:calls|commands)["']\s*:\s*\[/.test(e.textContent || ''));
    }, BASE_SELECTOR, { timeout: 15 * 60 * 1000, polling: 1000 }).then(() => true).catch(() => false);

    if (!found) {
        console.log('  Timed out waiting for a payload block.');
        await ctx.close();
        process.exit(1);
    }

    // Watch how the block mutates while the model streams, then describe it.
    const report = await page.evaluate(async ({ base, leaf }) => {
        const sleep = ms => new Promise(r => setTimeout(r, ms));
        const pick = () => [...document.querySelectorAll(base)]
            .filter(e => /["'](?:calls|commands)["']\s*:\s*\[/.test(e.textContent || ''))
            .pop();

        // Sample for a few seconds to see whether text is still growing.
        const samples = [];
        for (let i = 0; i < 6; i++) {
            const el = pick();
            samples.push(el ? (el.textContent || '').length : -1);
            await sleep(500);
        }

        const el = pick();
        if (!el) return { error: 'block vanished' };

        const text = el.textContent || '';
        const inner = el.innerText || '';
        const codes = {};
        for (const ch of text) {
            const c = ch.charCodeAt(0);
            if (c < 32 || c === 0xA0 || (c >= 0x200B && c <= 0x200D) || c === 0xFEFF) {
                codes[c] = (codes[c] || 0) + 1;
            }
        }

        const inputs = [...document.querySelectorAll(
            'textarea, [contenteditable="true"], [role="textbox"]')]
            .filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
            .map(e => ({ tag: e.tagName, editable: e.isContentEditable, role: e.getAttribute('role'), cls: (e.className || '').toString().slice(0, 80) }));

        const buttons = [...document.querySelectorAll('button')]
            .map(b => ((b.innerText || '') + ' ' + (b.getAttribute('aria-label') || '')).trim().toLowerCase())
            .filter(l => l && (l.includes('send') || l.includes('submit')));

        // Shadow roots anywhere would make querySelectorAll blind.
        let shadowHosts = 0;
        (function walk(n) {
            for (const c of n.children || []) { if (c.shadowRoot) shadowHosts++; walk(c); }
        })(document.body);

        return {
            block: {
                tag: el.tagName,
                className: (el.className || '').toString().slice(0, 120),
                dataLanguage: el.getAttribute('data-language'),
                isLeaf: !el.querySelector(leaf),
                parentTag: el.parentElement && el.parentElement.tagName,
                childTags: [...el.children].slice(0, 6).map(c => c.tagName),
            },
            text: {
                length: text.length,
                hasRealNewlines: text.includes('\n'),
                newlineCount: (text.match(/\n/g) || []).length,
                textContentEqualsInnerText: text === inner,
                innerTextNewlines: (inner.match(/\n/g) || []).length,
                first160: text.slice(0, 160),
                controlAndInvisibleCharCounts: codes,
            },
            streaming: { lengthSamples: samples, stillGrowing: samples[5] !== samples[0] },
            matchedBySelector: [...document.querySelectorAll(base)].length,
            leafCount: [...document.querySelectorAll(base)].filter(e => !e.querySelector(leaf)).length,
            inputs, sendButtons: buttons, shadowHosts,
            url: location.href,
        };
    }, { base: BASE_SELECTOR, leaf: LEAF_SELECTOR });

    // Keep one real block's markup so the test harness can be modelled on it.
    const html = await page.evaluate((sel) => {
        const el = [...document.querySelectorAll(sel)]
            .filter(e => /["'](?:calls|commands)["']\s*:\s*\[/.test(e.textContent || '')).pop();
        return el ? el.outerHTML.slice(0, 4000) : null;
    }, BASE_SELECTOR);

    report.sampleOuterHTML = html;
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2));

    console.log(JSON.stringify(report, null, 2));
    console.log(`\n  Report written to ${OUT}`);
    console.log('  Browser stays open; close it when done.\n');
})();
