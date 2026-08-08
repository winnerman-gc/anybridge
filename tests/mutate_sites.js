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
     [['            name: \'grok\',\n            host: /(^|\\.)(grok\\.com|x\\.ai)$/,\n            urlRe: null,\n            frame() {}',
       '            name: \'grok\',\n            host: /(^|\\.)(grok\\.com|x\\.ai)$/,\n            urlRe: /\\/rest\\/app-chat\\/conversations\\//,\n            frame(st, o) { if (o && o.responses) st.text += JSON.stringify(o.responses); }']]],

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
    ['replay: give an id-less payload a fresh id on every sighting',
     [['const commandId = payload.id || contentId(calls);',
       'const commandId = payload.id || `auto_${Date.now()}`;']], null, 'test_scan.js'],
];

let ok = 0, bad = 0;
for (const [name, from, to, suite] of MUTATIONS) {
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
            { env: { ...process.env, BRIDGE_SRC: TMP.replace(/\\/g, '/') }, encoding: 'utf8' });
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
