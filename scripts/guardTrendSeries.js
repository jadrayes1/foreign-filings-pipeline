#!/usr/bin/env node
// Publish-time "never narrower" guard for trend-series files.
//
// The per-merge rules (pickTrendToPublish) keep a series from narrowing only
// for points that pass through them, and every regression found so far came
// in some other way: VVV lost all four trend caches in the hard-failure
// fallback, KELYA/TDY lost FY '22 when two periods collided on one label
// inside the fresh data, and a shard publishing a file built from an older
// snapshot would have overwritten a hand restore. This checks the FINAL
// file against what is published right now, whatever produced it.
//
//   node scripts/guardTrendSeries.js snapshot <cloneDir> <file>...
//     copies each published file aside, right after cloning the gist
//   node scripts/guardTrendSeries.js check <cloneDir> <file>... [--alive <file>]
//     compares each rewritten file with its snapshot and repairs it in place
//
// A series is any array of {label, value} points. A published point may go
// missing only when:
//   - the series rolled forward: the point is older than everything the new
//     series holds, and the new series is no shorter than the old one;
//   - it was relabelled: its exact value (finite, non-zero) is still there
//     under another label;
//   - it had no value at all (a null placeholder);
// otherwise it is put back. A series or whole entry that disappeared is put
// back too -- except a ticker absent from the --alive file (marketMetrics),
// which the pipeline deliberately stopped publishing (delisted / dead).
// TREND_GUARD_ALLOW_SHRINK=1 skips the guard for a deliberate cleanup run;
// no workflow sets it.
//
// Kept byte-identical in stock-metrics-pipeline and foreign-filings-pipeline.

const fs = require('fs');
const os = require('os');
const path = require('path');

const SNAPSHOT_DIR = path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'trend-guard-snapshot');
const MAX_EXAMPLES = 15;

function labelOrdinal(label) {
  const m = /^(?:Q([1-4])|FY) '(\d{2})$/.exec(String(label || '').trim());
  if (!m) return null;
  return (2000 + Number(m[2])) * 4 + (m[1] ? Number(m[1]) : 4);
}

function isSeries(value) {
  return Array.isArray(value) && value.length > 0 && value.every((p) => p && typeof p === 'object' && !Array.isArray(p) && 'label' in p);
}

function sortSeries(points) {
  return points
    .map((p, i) => ({ p, i, o: labelOrdinal(p.label) }))
    .sort((a, b) => (a.o != null && b.o != null ? a.o - b.o : a.i - b.i))
    .map((x) => x.p);
}

// Returns the repaired series, recording any restored points in `report`.
function guardSeries(oldSeries, newSeries, where, report) {
  if (!Array.isArray(newSeries) || newSeries.length === 0) {
    report.series++;
    report.points += oldSeries.length;
    report.examples.push(`${where}: emptied -> restored ${oldSeries.length} points`);
    return oldSeries;
  }
  const newLabels = new Set(newSeries.map((p) => p.label));
  const newValues = new Set(newSeries.map((p) => p.value).filter((v) => Number.isFinite(v) && v !== 0));
  const newOrdinals = newSeries.map((p) => labelOrdinal(p.label)).filter((o) => o != null);
  const oldestNew = newOrdinals.length ? Math.min(...newOrdinals) : null;
  const rolledForward = newSeries.length >= oldSeries.length;
  const restore = [];
  for (const p of oldSeries) {
    if (newLabels.has(p.label)) continue;
    if (p.value == null) continue; // a placeholder with no value -- nothing to keep
    if (Number.isFinite(p.value) && p.value !== 0 && newValues.has(p.value)) continue; // relabelled
    const o = labelOrdinal(p.label);
    if (rolledForward && o != null && oldestNew != null && o < oldestNew) continue; // window roll
    restore.push(p);
  }
  if (!restore.length) return newSeries;
  report.series++;
  report.points += restore.length;
  report.examples.push(`${where}: restored ${restore.map((p) => p.label).join(', ')}`);
  return sortSeries([...newSeries, ...restore]);
}

function guardNode(oldNode, newNode, where, report, alive, depth) {
  if (isSeries(oldNode)) return guardSeries(oldNode, newNode, where, report);
  if (!oldNode || typeof oldNode !== 'object' || Array.isArray(oldNode)) return newNode;
  if (!newNode || typeof newNode !== 'object' || Array.isArray(newNode)) {
    // A whole object (a ticker's entry, a cadence) vanished or changed shape.
    report.series++;
    report.examples.push(`${where}: missing -> restored`);
    return oldNode;
  }
  const out = newNode;
  for (const [key, oldChild] of Object.entries(oldNode)) {
    const childWhere = where ? `${where}.${key}` : key;
    if (!(key in newNode)) {
      if (depth === 1 && alive && !alive.has(key)) continue; // a ticker the pipeline retired on purpose
      if (!containsSeries(oldChild)) continue;
      report.series++;
      report.examples.push(`${childWhere}: missing -> restored`);
      out[key] = oldChild;
      continue;
    }
    out[key] = guardNode(oldChild, newNode[key], childWhere, report, alive, depth + 1);
  }
  return out;
}

function containsSeries(node) {
  if (isSeries(node)) return true;
  if (!node || typeof node !== 'object') return false;
  return Object.values(node).some(containsSeries);
}

function loadAlive(file) {
  if (!file || !fs.existsSync(file)) return null;
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const metrics = data.metrics || data;
  return new Set(Array.isArray(metrics) ? metrics.map((m) => m.symbol) : Object.keys(metrics));
}

function main() {
  const [mode, cloneDir, ...rest] = process.argv.slice(2);
  const aliveIdx = rest.indexOf('--alive');
  const aliveFile = aliveIdx >= 0 ? rest[aliveIdx + 1] : null;
  const files = aliveIdx >= 0 ? rest.slice(0, aliveIdx) : rest;
  if (!['snapshot', 'check'].includes(mode) || !cloneDir || !files.length) {
    console.error('usage: guardTrendSeries.js snapshot|check <cloneDir> <file>... [--alive <file>]');
    process.exit(2);
  }
  if (mode === 'snapshot') {
    fs.rmSync(SNAPSHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
    for (const f of files) {
      const src = path.join(cloneDir, f);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(SNAPSHOT_DIR, f));
    }
    return;
  }
  if (process.env.TREND_GUARD_ALLOW_SHRINK === '1') {
    console.log('::warning::TREND_GUARD_ALLOW_SHRINK=1 -- publishing without the never-narrower guard.');
    return;
  }
  const alive = loadAlive(aliveFile);
  for (const f of files) {
    const snap = path.join(SNAPSHOT_DIR, f);
    const target = path.join(cloneDir, f);
    if (!fs.existsSync(snap) || !fs.existsSync(target)) continue;
    const oldData = JSON.parse(fs.readFileSync(snap, 'utf8'));
    const newData = JSON.parse(fs.readFileSync(target, 'utf8'));
    const report = { series: 0, points: 0, examples: [] };
    const oldRoot = oldData.trends ?? oldData;
    const newRoot = newData.trends ?? newData;
    const guarded = guardNode(oldRoot, newRoot, '', report, alive, 1);
    if (newData.trends !== undefined) newData.trends = guarded;
    if (!report.series) {
      console.log(`Trend guard: ${f} -- nothing narrowed.`);
      continue;
    }
    fs.writeFileSync(target, JSON.stringify(newData.trends !== undefined ? newData : guarded));
    console.log(`::warning::Trend guard: ${f} -- kept ${report.points} published points across ${report.series} series that this run would have dropped.`);
    for (const e of report.examples.slice(0, MAX_EXAMPLES)) console.log(`  ${e}`);
    if (report.examples.length > MAX_EXAMPLES) console.log(`  ... and ${report.examples.length - MAX_EXAMPLES} more`);
  }
}

if (require.main === module) main();
module.exports = { guardNode, guardSeries, labelOrdinal };
