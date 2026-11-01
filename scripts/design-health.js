#!/usr/bin/env node
'use strict';
// Measures every OpenVibe site's design health and writes server/design-health/snapshot.json, the snapshot openvibe.report/design
// shows (plan L45 step 6). The rules are server/design-health/scan.js: where a site hand-writes what the shared kit
// owns (motion durations and curves, theme colours), animates without asking for reduced motion, or spins.
//
// It reads checkouts, so it runs where the repos are (the orchestrator's workstation), never on the server:
//
//   node scripts/design-health.js                       every ~/openvibe/work/OpenVibe.* checkout, at its origin/main
//   node scripts/design-health.js --work <dir>          another folder of checkouts
//   node scripts/design-health.js --repo Live --no-fetch   just Live again; every other site keeps its last measure
//
// Each repo is read through a detached worktree of origin/main in a temp folder, removed again afterwards: no
// checkout is touched and no branch moves. The snapshot keeps every count and the first findings of each site, so it
// stays small; commit it with a PR to refresh the page.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { scanRepo, WEIGHTS, RULES } = require('../server/design-health/scan');

const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const WORK = opt('--work') || process.env.OV_WORK_DIR || path.join(os.homedir(), 'openvibe', 'work');
const ONLY = argv.reduce((a, v, i) => (argv[i - 1] === '--repo' ? a.concat(v.toLowerCase()) : a), []);
const FETCH = !argv.includes('--no-fetch');
const OUT = path.join(__dirname, '..', 'server', 'design-health', 'snapshot.json');
const KEEP = 25;   // findings kept per site; the counts are always the whole picture

const git = (dir, args, soft) => {
    try { return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); } catch (err) {
        if (soft) return null;
        throw new Error(`git ${args.join(' ')} in ${dir}: ${String(err.stderr || err.message).trim()}`);
    }
};
// The repo's name on GitHub, so a clone and a linked worktree of it are one site.
const nameOf = (dir) => { const url = git(dir, ['remote', 'get-url', 'origin'], true) || ''; const m = /([^/]+?)(\.git)?$/.exec(url); return m ? m[1] : path.basename(dir); };

function repos() {
    const seen = new Map();
    for (const d of fs.readdirSync(WORK).sort()) {
        if (!/^OpenVibe\./.test(d) && d !== 'OpenRestream') continue;
        const dir = path.join(WORK, d);
        if (!fs.existsSync(path.join(dir, '.git'))) continue;
        const name = nameOf(dir);
        if (!seen.has(name)) seen.set(name, dir);
    }
    return [...seen].filter(([name]) => !ONLY.length || ONLY.some((o) => name.toLowerCase().includes(o)));
}

function keep(findings) {
    const weight = (f) => WEIGHTS[f.rule] || 0;
    const ordered = findings.map((f, i) => ({ f, i })).sort((a, b) => weight(b.f) - weight(a.f) || a.i - b.i);
    const perFile = new Map(), picked = [];
    for (let round = 0; picked.length < KEEP && picked.length < ordered.length; round++) {
        for (const x of ordered) {
            if (picked.length >= KEEP) break;
            if (x.taken || (perFile.get(x.f.file) || 0) !== round) continue;
            x.taken = true; perFile.set(x.f.file, round + 1); picked.push(x);
        }
    }
    return picked.sort((a, b) => weight(b.f) - weight(a.f) || a.i - b.i).map((x) => x.f);
}

function measure(name, dir, tmp) {
    const wt = path.join(tmp, name.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
    let added = false;
    try {
        if (FETCH) git(dir, ['fetch', '--quiet', 'origin', '+refs/heads/main:refs/remotes/origin/main'], true);
        const commit = git(dir, ['rev-parse', 'origin/main'], true);
        if (!commit) return null;
        git(dir, ['worktree', 'add', '--detach', wt, 'origin/main']);
        added = true;
        const r = scanRepo(wt);
        return {
            repo: name, commit, files_scanned: r.files_scanned, counts: r.counts, score: r.score, findings_total: r.findings.length,
            // The findings kept matter most (by the rule's weight), spread over as many files as possible.
            findings: keep(r.findings).map((f) => ({ rule: f.rule, file: f.file, line: f.line, value: f.value == null ? null : String(f.value).slice(0, 60), text: String(f.text || '').trim().slice(0, 160) })),
        };
    } finally {
        if (added) { git(dir, ['worktree', 'remove', '--force', wt], true); git(dir, ['worktree', 'prune'], true); }
        fs.rmSync(wt, { recursive: true, force: true });
    }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'design-health-'));
const sites = [];
try {
    for (const [name, dir] of repos()) {
        const s = measure(name, dir, tmp);
        if (s && s.files_scanned) sites.push(s);   // a repo with no stylesheet where the rules read is not a site to score
        process.stdout.write(`${name.padEnd(24)} ${s ? `${String(s.score).padStart(6)}  ${s.findings_total} findings` : 'skipped (no origin/main)'}\n`);
    }
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
// With --repo, only those sites are measured again: the others keep what the snapshot already has.
if (ONLY.length) {
    let before = [];
    try { before = JSON.parse(fs.readFileSync(OUT, 'utf8')).sites || []; } catch { before = []; }
    const fresh = new Set(sites.map((s) => s.repo));
    sites.push(...before.filter((s) => !fresh.has(s.repo)));
}
sites.sort((a, b) => a.repo.localeCompare(b.repo));
fs.writeFileSync(OUT, `${JSON.stringify({ generated_at: new Date().toISOString(), rules: RULES, weights: WEIGHTS, kept: KEEP, sites }, null, 1)}\n`);
process.stdout.write(`\nwrote ${path.relative(process.cwd(), OUT)}: ${sites.length} sites\n`);
