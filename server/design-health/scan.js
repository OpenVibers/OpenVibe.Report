'use strict';
// The design-health rules (plan L45 step 6), served by openvibe.report/design. They began as the orchestrator's
// tools/design-lint and live here now so the measure is as open as its results; scripts/design-health.js runs them.
// Reads every CSS file and every inline <style> in HTML and JS under public/, server/views/ and
// apps/*/public/, and reports where a site hand-writes what the shared kit already owns:
//
//   literal_duration        a transition/animation duration written as a literal (.25s, 300ms)
//                           where the kit says var(--ov-dur-1..4)
//   literal_curve           cubic-bezier(...) or an ease keyword where the kit says var(--ov-ease-*)
//   spinner                 @keyframes that rotate 360deg, and an animation that runs one forever
//   color_drift             a hard-coded colour in a file that already uses the theme variables
//   missing_reduced_motion  a file that animates and never asks prefers-reduced-motion
//
// node_modules, vendor and .min. files are skipped. The scanner never writes; it only reads.
//
//   node scan.js <repo dir>              JSON of the counts and findings on stdout
//   node scan.js <repo dir> --summary    one line per rule
//
// The finding kinds are the same keys the report counts by, so a caller can group either way.

const fs = require('fs');
const path = require('path');

// ── what the kit owns ─────────────────────────────────────────────────────────────────────────────────────────
// the theme colour variables, from openvibe-shared/theme-loader.js THEME_KEYS
const THEME_KEYS = ['--bg-primary', '--bg-secondary', '--bg-tertiary', '--bg-card', '--bg-hover', '--bg-input',
    '--text-primary', '--text-secondary', '--text-muted', '--accent', '--accent-light', '--accent-dark',
    '--border', '--border-light', '--live-red', '--success', '--warning', '--danger', '--info',
    '--shadow', '--shadow-lg', '--success-text', '--warning-text', '--danger-text', '--info-text',
    '--live-red-text', '--accent-strong', '--on-accent-strong', '--on-accent', '--accent-rgb',
    '--accent-glow', '--color-scheme'];
const THEME_SET = new Set(THEME_KEYS);

// how much each rule costs a site its score: a spinner weighs most (nothing spins), then a file that
// never asks prefers-reduced-motion, then a hand-written duration or curve, then a hand-written colour
const WEIGHTS = {
    spinner: 4,
    missing_reduced_motion: 2,
    literal_duration: 0.25,
    literal_curve: 0.25,
    color_drift: 0.05
};

const RULES = ['literal_duration', 'literal_curve', 'spinner', 'color_drift', 'missing_reduced_motion'];

// the directories a site keeps its styles in
const STYLE_ROOTS = ['public', 'server/views'];
const APP_ROOT = 'apps';

// the properties that carry a duration, and the ones that carry a curve
const DURATION_PROPS = new Set(['transition', 'transition-duration', 'animation', 'animation-duration']);
const CURVE_PROPS = new Set(['transition', 'transition-timing-function', 'animation', 'animation-timing-function']);

const SKIP_DIRS = new Set(['node_modules', 'vendor', '.git']);
const CSS_EXT = new Set(['.css']);
const MARKUP_EXT = new Set(['.html', '.htm']);
const SCRIPT_EXT = new Set(['.js', '.mjs', '.cjs']);

// the keywords an animation shorthand can hold, so the name of the keyframes can be told from the rest
const ANIM_KEYWORDS = new Set(['infinite', 'linear', 'ease', 'ease-in', 'ease-out', 'ease-in-out', 'normal',
    'reverse', 'alternate', 'alternate-reverse', 'forwards', 'backwards', 'both', 'none', 'running', 'paused',
    'step-start', 'step-end']);

// the colours a site may name, when it should be asking the theme
const NAMED_COLOURS = new Set(['white', 'black', 'red', 'green', 'blue', 'yellow', 'orange', 'purple', 'pink',
    'gray', 'grey', 'silver', 'gold', 'navy', 'teal', 'maroon', 'olive', 'lime', 'aqua', 'fuchsia', 'cyan',
    'magenta', 'crimson', 'indigo', 'violet', 'salmon', 'tan', 'khaki', 'beige', 'ivory', 'lavender',
    'turquoise', 'plum', 'orchid', 'coral', 'tomato', 'chocolate', 'sienna', 'darkred', 'darkblue', 'darkgreen']);

const TIME_RE = /(?<![\w.-])(\d*\.?\d+)(ms|s)\b/gi;
const TIME_ONLY_RE = /^(?:\d*\.?\d+)(?:ms|s)$/i;
const CURVE_FN_RE = /cubic-bezier\s*\(/gi;
const EASE_RE = /(?<![\w-])(ease-in-out|ease-in|ease-out|ease)(?![\w-])/gi;
const HEX_RE = /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/g;
const FUNC_COLOUR_RE = /\b(?:rgba?|hsla?)\([^)]*\)/gi;
// hue-rotate(360deg) cycles a colour, it does not turn anything: not a spinner (Live's eggRainbow, 2026-11-01).
const SPIN_RE = /(?<!hue-)rotate\(\s*(?:360(?:\.0+)?deg|1turn|2turn|-360(?:\.0+)?deg)\s*\)/i;

// ── helpers ────────────────────────────────────────────────────────────────────────────────────────────────
// the fallback inside var(--name, fallback) is a stand-in, not a choice: look past it
const VAR_WITH_FALLBACK_RE = /var\(\s*(--[\w-]+)\s*,(?:[^()]*|\([^()]*\))*\)/gi;
function stripVarFallbacks(value) {
    return value.replace(VAR_WITH_FALLBACK_RE, 'var($1)');
}

// the theme variables a value asks for
function themeVarsIn(value) {
    const found = new Set();
    const re = /var\(\s*(--[\w-]+)/g;
    let m;
    while ((m = re.exec(value))) found.add(m[1]);
    return found;
}

function isThemeVar(name) {
    return THEME_SET.has(name);
}

// the hard-coded colours in a value
function coloursIn(value) {
    const out = [];
    const text = stripVarFallbacks(value).replace(/url\([^)]*\)/gi, 'url()');
    let m;
    HEX_RE.lastIndex = 0;
    while ((m = HEX_RE.exec(text))) out.push(m[0]);
    FUNC_COLOUR_RE.lastIndex = 0;
    while ((m = FUNC_COLOUR_RE.exec(text))) out.push(m[0]);
    const re = /(?<![\w-#])([a-zA-Z]{3,20})(?![\w-])/g;
    while ((m = re.exec(text))) {
        const name = m[1].toLowerCase();
        if (NAMED_COLOURS.has(name)) out.push(name);
    }
    return out;
}

// the duration literals in a value
function durationsIn(value) {
    const out = [];
    const text = stripVarFallbacks(value);
    TIME_RE.lastIndex = 0;
    let m;
    while ((m = TIME_RE.exec(text))) out.push(m[0]);
    return out;
}

// the curves written out in a value
function curvesIn(value) {
    const out = [];
    const text = stripVarFallbacks(value);
    CURVE_FN_RE.lastIndex = 0;
    let m;
    while ((m = CURVE_FN_RE.exec(text))) out.push(m[0]);
    EASE_RE.lastIndex = 0;
    while ((m = EASE_RE.exec(text))) out.push(m[1]);
    return out;
}

// the keyframes an animation shorthand names
function animationName(value) {
    const text = value.replace(/var\([^)]*\)/gi, ' ');
    const tokens = text.split(/[\s,]+/).filter(Boolean);
    for (const tok of tokens) {
        const t = tok.toLowerCase();
        if (ANIM_KEYWORDS.has(t)) continue;
        if (TIME_ONLY_RE.test(t)) continue;
        if (/^cubic-bezier\(/i.test(t) || /^steps\(/i.test(t)) continue;
        return tok;
    }
    return null;
}

// ── the CSS reader ─────────────────────────────────────────────────────────────────────────────────────────
// a small reader: enough to know which declaration sits on which line, which rule it belongs to
// and which keyframes it is inside
function parseCss(src, baseLine) {
    const decls = [];
    const keyframes = [];
    let i = 0;
    let line = baseLine;
    let uid = 0;
    const len = src.length;

    function skipComment() {
        const end = src.indexOf('*/', i + 2);
        const stop = end < 0 ? len : end + 2;
        for (let k = i; k < stop; k++) if (src[k] === '\n') line++;
        i = stop;
    }

    function consumeString() {
        const q = src[i];
        let k = i + 1;
        let out = q;
        while (k < len) {
            const ch = src[k];
            if (ch === '\\') { out += src[k] + (src[k + 1] || ''); k += 2; continue; }
            out += ch;
            k++;
            if (ch === q) break;
        }
        for (let x = i; x < k; x++) if (src[x] === '\n') line++;
        i = k;
        return out;
    }

    function flush(buf, bufLine, chain) {
        const text = buf.trim();
        if (!text) return;
        const colon = text.indexOf(':');
        if (colon < 0) return;
        const prop = text.slice(0, colon).trim();
        const value = text.slice(colon + 1).trim();
        if (!prop || !value) return;
        if (/[{}]/.test(prop)) return;
        const owner = chain[chain.length - 1];
        let kf = null;
        for (const b of chain) if (b.kf) kf = b.kf;
        const decl = { prop, value, line: bufLine, rule: owner, keyframes: kf };
        decls.push(decl);
        if (kf) kf.decls.push(decl);
    }

    function parseBlock(chain) {
        let buf = '';
        let bufLine = line;
        for (;;) {
            if (i >= len) break;
            const c = src[i];
            if (c === '/' && src[i + 1] === '*') { skipComment(); buf = ''; bufLine = line; continue; }
            if (c === '"' || c === "'") { if (!buf.trim()) bufLine = line; buf += consumeString(); continue; }
            if (c === '{') {
                const prelude = buf.trim();
                buf = '';
                bufLine = line;
                const child = { id: ++uid, type: 'rule', selector: prelude, at: null, keyframes: null, parent: chain[chain.length - 1] };
                const am = /^@([\w-]+)/.exec(prelude);
                if (am) {
                    child.type = 'at';
                    child.at = am[1].toLowerCase();
                    const km = /^@(?:-webkit-)?keyframes\s+("[^"]+"|'[^']+'|[^\s{]+)/i.exec(prelude);
                    if (child.at === 'keyframes' || child.at === '-webkit-keyframes') {
                        child.keyframes = km ? km[1].replace(/^["']|["']$/g, '') : null;
                        keyframes.push({ name: child.keyframes, line: bufLine, decls: [] });
                        child.kf = keyframes[keyframes.length - 1];
                    }
                }
                i++;
                chain.push(child);
                parseBlock(chain);
                chain.pop();
                buf = '';
                bufLine = line;
                continue;
            }
            if (c === '}') { i++; flush(buf, bufLine, chain); return; }
            if (c === ';') { i++; flush(buf, bufLine, chain); buf = ''; bufLine = line; continue; }
            if (c === '\n') { line++; buf += c; i++; continue; }
            // the declaration starts at its first real character, not at the whitespace before it
            if (!buf.trim()) bufLine = line;
            buf += c;
            i++;
        }
        flush(buf, bufLine, chain);
    }

    const root = { id: 0, type: 'root', selector: '', at: null, keyframes: null, parent: null };
    parseBlock([root]);
    return { decls, keyframes };
}

// ── the units a file is made of ─────────────────────────────────────────────────────────────────────────────
// a CSS file is one unit; an HTML or JS file is one unit per inline <style>
function unitsIn(file, text) {
    const units = [];
    const ext = path.extname(file).toLowerCase();
    if (CSS_EXT.has(ext)) {
        units.push({ kind: 'css', line: 1, text });
        return units;
    }
    if (!MARKUP_EXT.has(ext) && !SCRIPT_EXT.has(ext)) return units;
    const re = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
    let m;
    while ((m = re.exec(text))) {
        const before = text.slice(0, m.index);
        const line = 1 + (before.match(/\n/g) || []).length;
        units.push({ kind: 'inline-style', line, text: m[1] });
    }
    return units;
}

// ── the walk ─────────────────────────────────────────────────────────────────────────────────────────────────
function styleRoots(repoDir) {
    const roots = [];
    for (const rel of STYLE_ROOTS) {
        const p = path.join(repoDir, rel);
        if (fs.existsSync(p) && fs.statSync(p).isDirectory()) roots.push(p);
    }
    const apps = path.join(repoDir, APP_ROOT);
    if (fs.existsSync(apps) && fs.statSync(apps).isDirectory()) {
        for (const name of fs.readdirSync(apps)) {
            const p = path.join(apps, name, 'public');
            if (fs.existsSync(p) && fs.statSync(p).isDirectory()) roots.push(p);
        }
    }
    return roots;
}

function walk(dir, out) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
    for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
            if (SKIP_DIRS.has(e.name)) continue;
            walk(p, out);
        } else if (e.isFile()) {
            if (e.name.includes('.min.')) continue;
            out.push(p);
        }
    }
    return out;
}

// ── the lint ───────────────────────────────────────────────────────────────────────────────────────────────
// scan one repo directory and return its counts, its findings and its score
function scanRepo(repoDir) {
    const root = path.resolve(repoDir);
    const findings = [];
    const files = [];
    const roots = styleRoots(root);

    for (const r of roots) {
        for (const file of walk(r, [])) {
            const ext = path.extname(file).toLowerCase();
            if (!CSS_EXT.has(ext) && !MARKUP_EXT.has(ext) && !SCRIPT_EXT.has(ext)) continue;
            let text;
            try { text = fs.readFileSync(file, 'utf8'); } catch (e) { continue; }
            files.push(file);
            const rel = path.relative(root, file);
            const units = unitsIn(file, text);
            if (!units.length) continue;
            findings.push(...lintFile(root, rel, text, units, file));
        }
    }

    // the keyframes of a repo, so an animation can be traced back to the one it runs
    const counts = { literal_duration: 0, literal_curve: 0, spinner: 0, color_drift: 0, missing_reduced_motion: 0, total: 0 };
    const by_kind = {};
    for (const f of findings) {
        counts[f.rule] = (counts[f.rule] || 0) + 1;
        by_kind[f.kind] = (by_kind[f.kind] || 0) + 1;
    }
    counts.total = findings.length;

    findings.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
    return { repo: path.basename(root), counts, by_kind: by_kind, score: scoreOf(counts), findings, files_scanned: files.length };
}

// the lint of one file
function lintFile(root, rel, text, units, file) {
    const out = [];
    const lines = text.split('\n');
    const lineText = (n) => (lines[n - 1] || '').trim().slice(0, 200);

    const parsed = units.map((u) => Object.assign({}, u, parseCss(u.text, u.line)));
    const allDecls = [];
    const allKeyframes = [];
    for (const p of parsed) { allDecls.push(...p.decls); allKeyframes.push(...p.keyframes); }

    // what this file asks the theme for
    const fileThemeVars = new Set();
    for (const d of allDecls) for (const name of themeVarsIn(d.value)) fileThemeVars.add(name);
    const fileUsesTheme = [...fileThemeVars].some(isThemeVar);
    const fileHasReducedMotion = /prefers-reduced-motion/i.test(text);

    // which rule uses a theme variable: a rule that does is themed, a hard-coded colour in it is drift
    const ruleThemeVars = new Map();
    for (const d of allDecls) {
        if (!d.rule) continue;
        if (!ruleThemeVars.has(d.rule.id)) ruleThemeVars.set(d.rule.id, new Set());
        const set = ruleThemeVars.get(d.rule.id);
        for (const name of themeVarsIn(d.value)) set.add(name);
    }

    // the keyframes that turn, anywhere in this file
    const spinNames = new Set();
    for (const kf of allKeyframes) {
        const turns = kf.decls.some((d) => SPIN_RE.test(d.value));
        if (turns && kf.name) spinNames.add(kf.name);
    }

    // the custom properties this file keeps for itself
    const ownPalette = new Set();

    // the animation declarations, grouped by the rule they sit in
    const rules = new Map();
    for (const d of allDecls) {
        const id = d.rule ? d.rule.id : 0;
        if (!rules.has(id)) rules.set(id, { rule: d.rule, decls: [] });
        rules.get(id).decls.push(d);
    }

    for (const d of allDecls) {
        const prop = d.prop.toLowerCase();
        const value = d.value;
        const line = d.line;
        const at = { file: rel, line, text: lineText(line) };

        // durations written out (the kit's own token definitions are the kit, not drift)
        if (DURATION_PROPS.has(prop) && !/^--ov-/.test(prop)) {
            for (const dur of durationsIn(value)) {
                out.push(Object.assign({ rule: 'literal_duration', kind: 'duration', value: dur, detail: prop + ' uses ' + dur + ' where the kit says var(--ov-dur-1..4)' }, at));
            }
        }

        // curves written out (the kit's own token definitions are the kit, not drift)
        if (CURVE_PROPS.has(prop) && !/^--ov-/.test(prop)) {
            for (const curve of curvesIn(value)) {
                out.push(Object.assign({ rule: 'literal_curve', kind: 'curve', value: curve, detail: prop + ' uses ' + curve + ' where the kit says var(--ov-ease-out / -spring / -in-out)' }, at));
            }
        }

        // hard-coded colours, in a file that already uses the theme
        if (fileUsesTheme) {
            const themed = d.rule && ruleThemeVars.get(d.rule.id) && [...ruleThemeVars.get(d.rule.id)].some(isThemeVar);
            const colours = coloursIn(value);
            if (colours.length) {
                // a custom property is a palette: one finding for the property, not one per value
                if (prop.startsWith('--')) {
                    if (!ownPalette.has(prop)) {
                        ownPalette.add(prop);
                        out.push(Object.assign({
                            rule: 'color_drift', kind: 'own_palette',
                            value: prop + ' ' + colours[0],
                            detail: 'the file uses theme variables and still keeps its own ' + prop
                        }, at));
                    }
                } else {
                    for (const colour of colours) {
                        out.push(Object.assign({
                            rule: 'color_drift', kind: themed ? 'colour_in_themed_rule' : 'colour_in_themed_file',
                            value: colour,
                            detail: (themed ? 'the rule uses theme variables and still writes ' : 'the file uses theme variables and still writes ') + colour
                        }, at));
                    }
                }
            }
        }
    }

    // spinners: the keyframes that turn, and the animations that run them forever
    for (const kf of allKeyframes) {
        if (!kf.name || !spinNames.has(kf.name)) continue;
        out.push({ rule: 'spinner', kind: 'spinner_keyframes', file: rel, line: kf.line, text: lineText(kf.line), value: kf.name, detail: '@keyframes ' + kf.name + ' turns 360deg' });
    }
    for (const group of rules.values()) {
        const hasInfinite = group.decls.some((d) => /^(-webkit-)?animation(-iteration-count)?$/.test(d.prop.toLowerCase()) && /\binfinite\b/i.test(d.value));
        for (const d of group.decls) {
            const prop = d.prop.toLowerCase();
            if (prop !== 'animation' && prop !== '-webkit-animation' && prop !== 'animation-name') continue;
            const name = prop === 'animation-name' ? d.value.trim() : animationName(d.value);
            if (!name || !spinNames.has(name)) continue;
            const infinite = /\binfinite\b/i.test(d.value) || (prop === 'animation-name' && hasInfinite);
            if (!infinite) continue;
            out.push({ rule: 'spinner', kind: 'spinner_usage', file: rel, line: d.line, text: lineText(d.line), value: name, detail: 'animation runs ' + name + ' forever' });
        }
    }

    // a file that animates and never asks prefers-reduced-motion
    if (!fileHasReducedMotion) {
        const first = allDecls.find((d) => /^(-webkit-)?animation(-name)?$/.test(d.prop.toLowerCase()) && !/^none$/i.test(d.value.trim()));
        if (first) {
            out.push({ rule: 'missing_reduced_motion', kind: 'missing_reduced_motion', file: rel, line: first.line, text: lineText(first.line), value: first.prop, detail: 'the file animates and never asks prefers-reduced-motion' });
        }
    }

    return out;
}

// ── the score ───────────────────────────────────────────────────────────────────────────────────────────────
// 100 minus what the findings cost, never below 0
function scoreOf(counts) {
    let score = 100;
    for (const rule of RULES) score -= (counts[rule] || 0) * (WEIGHTS[rule] || 0);
    return Math.max(0, Math.min(100, Math.round(score * 100) / 100));
}

// ── the command line ───────────────────────────────────────────────────────────────────────────────────────
function main(argv) {
    const args = argv.filter((a) => !a.startsWith('--'));
    const summary = argv.includes('--summary');
    if (!args.length) {
        process.stderr.write('usage: node scan.js <repo dir> [--summary]\n');
        process.exit(2);
    }
    const dir = args[0];
    if (!fs.existsSync(dir)) {
        process.stderr.write('scan: no such directory: ' + dir + '\n');
        process.exit(2);
    }
    const result = scanRepo(dir);
    if (summary) {
        const parts = RULES.map((r) => r + '=' + result.counts[r]);
        process.stdout.write(result.repo + '  score=' + result.score + '  files=' + result.files_scanned + '  ' + parts.join('  ') + '\n');
    } else {
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    }
}

module.exports = { scanRepo, scoreOf, lintFile, parseCss, THEME_KEYS, WEIGHTS, RULES };

if (require.main === module) main(process.argv.slice(2));
