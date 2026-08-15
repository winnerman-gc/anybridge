// Break each adapter's reasoning filter one at a time and confirm the matching
// test actually notices. A safety test that passes against a broken filter is
// being protected by something else and proves nothing.
const fs = require('fs');
const { execFileSync } = require('child_process');
const SRC = require('path').join(__dirname, '..', 'userscript', 'bridge.user.js');
const TMP = __dirname + '/mutant.js';
// Normalised to LF before anything is matched. Several anchors below span
// lines, and on a Windows checkout with autocrlf the file arrives with CRLF -
// so every multi-line anchor silently stops matching and the run reports the
// mutation as inapplicable rather than as a hole in the tests.
const orig = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');

const MUTATIONS = [
    ['scan: never walk back to the enclosing object',
     [['const MAX_BACKTRACK = 4000;', 'const MAX_BACKTRACK = 0;']]],

    ['scan: accept an object that closes before the marker',
     [['if (!jsonStr || i + jsonStr.length <= m.index) continue;', 'if (!jsonStr) continue;']]],

    ['qwen: drop the phase filter',
     "if (d.phase && d.phase !== 'answer') return;   // reasoning phase", ''],

    ['chatgpt: accept any /message/content path',
     "if (!/\\/message\\/content\\/parts\\/0$/.test(path)) return;",
     "if (!/\\/message\\/content\\//.test(path)) return;"],

    ['chatgpt: ignore the active-message gate',
     "if (st.active === false) return;          // wrong message (reasoning, tool call)", ''],

    ['claude: fold thinking_delta into the answer',
     "if (o.delta.type === 'text_delta' && typeof o.delta.text === 'string')\n                        st.text += o.delta.text;",
     "st.text += (o.delta.text || o.delta.thinking || '');"],

    // Individually these two are redundant - each alone still blocks every real
    // frame. Removed together they are the careless adapter that folds the
    // reasoning trace, and the echoed user prompt, straight into the answer.
    ['kimi: mask filter AND text-only access both removed',
     [["if (!o.mask.startsWith('block.text')) return;", ''],
      ['const c = o.block && o.block.text && o.block.text.content;',
       'const c = o.block && ((o.block.text && o.block.text.content) || (o.block.think && o.block.think.content));']]],

    ['kimi: treat a framing "{" as a frame start (the stall bug)',
     "if (/^\\{\\s*\"/.test(head)) break;", "if (true) break;"],

    ['deepseek: ignore which fragment type is current',
     "if (st.dsType !== 'RESPONSE') return;", ''],

    ['deepseek: skip the opening snapshot that sets the first fragment type',
     [['if ((o.p === undefined || o.p === \'\') && o.v && o.v.response\n                    && Array.isArray(o.v.response.fragments)) {\n                    dsFragments(st, o.v.response.fragments);\n                    return;\n                }', '']]],

    // Grok is DOM-only; giving it back a urlRe means the stream hook installs
    // and starts parsing load-responses, i.e. the conversation history.
    ['grok: re-enable stream interception on its conversation URLs',
     [['            urlRe: null,\n            answer: \'[data-testid="assistant-message"]\',\n            frame() {}',
       '            urlRe: /\\/rest\\/app-chat\\/conversations\\//,\n            answer: \'[data-testid="assistant-message"]\',\n            frame(st, o) { if (o && o.responses) st.text += JSON.stringify(o.responses); }']]],

    ['gemini: append snapshots instead of replacing',
     'if (typeof txt === \'string\' && txt) st.text = txt;',
     'if (typeof txt === \'string\' && txt) st.text += txt;'],

    // The primed system prompt is a USER message containing a valid example
    // payload. Without this guard the prime button hands the scanner a tool
    // call to execute, and burns the id of the model's first real block.
    ['prime: act on payloads found in the injected system prompt',
     [['if (isPrimerText(text)) {', 'if (false) {']], null, 'test_scan.js'],

    // Back to a clock-derived id, which is unique on every scan - so the replay
    // guard can neither recognise nor record it, and an id-less payload runs
    // again every time its text comes back round.
    // Back to executing any code block on the page, whoever wrote it - which
    // includes the user's own messages and anything a page chose to render.
    ['scope: treat every code block on the page as the model talking',
     [['            if (!authoredByModel(el)) continue;\n', '']], null, 'test_scan.js'],

    ['replay: give an id-less payload a fresh id on every sighting',
     [['const commandId = payload.id || contentId(calls);',
       'const commandId = payload.id || `auto_${Date.now()}`;']], null, 'test_scan.js'],

    // A hidden tab's timers are throttled to one a second, then one a minute.
    // With only the ticker to go on, the bridge appears to stop working the
    // moment you switch tabs.
    ['dormancy: leave a hidden tab to its throttled ticker',
     [['        if (document.hidden && Date.now() - lastScanAt >= SCAN_GAP_MS) scanNow(false);\n', '']],
     null, 'test_scan.js'],

    // A frozen tab misses the end of a response entirely. If waking up does not
    // catch up, that payload is never seen.
    ['dormancy: do not rescan when the tab wakes',
     [['        lastScanAt = 0;\n        scanNow(true);', '        lastScanAt = 0;']],
     null, 'test_scan.js'],

    // A permanent latch here meant one interrupted stream disabled the DOM
    // fallback for the life of the page.
    ['dormancy: trust the stream forever again',
     [['const STREAM_TRUST_MS = 30000;', 'const STREAM_TRUST_MS = 1e12;']],
     null, 'test_scan.js'],

    // The agent hands out a pairing token ONCE per run, so a rescan that wipes
    // it kills the bridge until the agent is restarted.
    ['dormancy: let a manual rescan wipe the pairing token',
     [["const CONFIG_KEYS = ['bridge_hosts', AWAKE_KEY, TOKEN_KEY];",
       "const CONFIG_KEYS = ['bridge_hosts'];"]], null, 'test_scan.js'],

    // The upload is a real one to the provider and takes seconds. Sending as
    // soon as the File is handed over produces a message with no image in it,
    // and nothing anywhere reports a failure.
    ['image: send without waiting for the upload to land',
     [['        if (await waitForThumb(name, before)) return name;', '        return name;']],
     null, 'test_image.js'],

    // A model told the image is attached, looking at a message without one,
    // does not say "I cannot see it" - it describes something plausible.
    ['image: report a failed attach as a success',
     [['notes.push(`(anybridge could NOT attach ${r.name || r.path}: ${e.message} `\n'
       + '                    + `- there is no image in this message)`);',
       'notes.push(`(anybridge attached ${r.name || r.path})`);']], null, 'test_image.js'],

    // Attaching where no selector was measured means there is nothing to wait
    // on, so the wait above cannot work either.
    ['image: attach on a site with no measured attach path',
     [['        if (!site.attach) {', '        if (false) {']], null, 'test_image.js',
     { BRIDGE_TEST_URL: 'https://chatgpt.com/c/abc123' }],
];

let ok = 0, bad = 0;
for (const [name, from, to, suite, env] of MUTATIONS) {
    // A mutation is either one from/to pair, or a list of them applied together.
    const pairs = Array.isArray(from) ? from : [[from, to]];
    // A list-form entry written as [from, to] instead of [[from, to]] silently
    // destructures the STRING - f becomes its first character, which is always
    // present, so the mutation "applies" as a one-letter corruption and the
    // suite passes. That reads as WEAK coverage when the test is in fact fine.
    const malformed = pairs.filter(p => !Array.isArray(p) || typeof p[0] !== 'string');
    if (malformed.length) { console.log(`  BAD  ${name}: mutation must be [[from, to], ...]`); bad++; continue; }
    const missing = pairs.filter(([f]) => !orig.includes(f));
    if (missing.length) { console.log(`  ?? ${name}: anchor not found - mutation did not apply`); bad++; continue; }
    fs.writeFileSync(TMP, pairs.reduce((s, [f, t]) => s.replace(f, t), orig));
    let out = '';
    try {
        // A mutation names its own suite when the guard it breaks lives outside
        // the adapters; SUITE overrides everything for one-off runs.
        out = execFileSync(process.execPath, [__dirname + '/' + (process.env.SUITE || suite || 'test_sites.js')],
            // A mutation may also name the environment its suite needs, for a
            // guard that only exists on some sites.
            { env: { ...process.env, BRIDGE_SRC: TMP.replace(/\\/g, '/'), ...(env || {}) },
              encoding: 'utf8' });
        console.log(`  WEAK ${name}: suite still passed`);
        bad++;
    } catch (e) {
        const text = (e.stdout || '') + (e.stderr || '');
        const failed = [...text.matchAll(/ {2}FAIL {2}(.+)/g)].map(m => m[1].trim());
        console.log(`  DETECTED ${name}`);
        failed.forEach(f => console.log(`           -> ${f}`));
        ok++;
    }
}
fs.unlinkSync(TMP);
console.log(`\n${ok}/${MUTATIONS.length} mutations detected, ${bad} undetected`);
process.exit(bad ? 1 : 0);
