// scripts/generateForeignPfcfCache.js
//
// P/FCF trend (Quarterly/Yearly/TTM) for FOREIGN-FILER tickers — see
// generateForeignFilingsCache.js's file header for the full rationale on
// why foreign private issuers (40-F/20-F/6-K filers) need this separate
// SEC-EDGAR-based reconstruction at all. Split into its OWN script/workflow
// rather than folded into generateForeignFilingsCache.js, for the same
// reason generatePfcfTrendCache.js is split from generateSectorMetrics.js
// in the stock-metrics-pipeline repo: P/FCF needs historical PRICES on top
// of SEC filings data, which come from Twelve Data (a separate provider,
// separate rate-limit budget) — everything else in this repo only ever
// talks to SEC.
//
// Uses its OWN Twelve Data API key (TWELVEDATA_FOREIGN_PIPELINE_API_KEY),
// separate from both the app's live-fallback key (TWELVEDATA_API_KEY on the
// proxy) AND stock-metrics-pipeline's own batch key
// (TWELVEDATA_PIPELINE_API_KEY) — sharing any of those would mean this job
// competes with live user traffic or another batch job for the same
// 800-calls/day free-tier budget. Twelve Data's free tier allows creating
// additional accounts at no cost.
//
// Like stock-metrics-pipeline's P/FCF job, this uses a least-recently-
// attempted-first rotation (see MAX_TWELVEDATA_CALLS_PER_RUN/TIME_BUDGET_MS
// below) — the foreign-filer universe grew to ~769 candidates
// (discoverForeignFilers.js), too large to fit in this workflow's 60-minute
// timeout in one pass; see the GIST_FOREIGN_FILER_LIST_URL comment below for
// the verified failure mode this fixes.

const fs = require('fs');
const path = require('path');
// Reused rather than duplicated -- both scripts live in this same repo
// (unlike the cross-REPO duplication this codebase otherwise deliberately
// uses for genuinely separate pipelines), and requiring it here has no
// side effects (its own `if (require.main === module)` guard means main()
// only runs when THIS file is the entry point, not when it's required).
const { isGenuineForeignFiler, needsFilingTextBackfill, needsAnnual20FBackfill } = require('./generateForeignFilingsCache');
const { extractQuarterlyFactsFromFilings, extractAnnualFactsFrom20F, computeCumulativeFallbackConcepts, convertNativeCurrencyToUsd } = require('./lib/extractFilingTextFacts');
const { fetchBusinessQuantFacts } = require('./lib/businessQuantFallback');

const OUTPUT_FILE = path.join(__dirname, '../foreignPfcfCache.json');
const GIST_METRICS_URL = 'https://gist.githubusercontent.com/jadrayes1/5cd7f459788725521246717b9e164a8e/raw/marketMetrics.json';
const GIST_FOREIGN_PFCF_URL = 'https://gist.githubusercontent.com/jadrayes1/5cd7f459788725521246717b9e164a8e/raw/foreignPfcfCache.json';
// P/E rides on the SAME shared gist file the app already reads for the
// DOMESTIC pipeline's own P/E reconstruction (stock-metrics-pipeline's
// generatePfcfTrendCache.js) -- src/api/sectorComparison.js's
// fetchCachedPeTrend reads `trends[symbol].pe.{cadence}` from this exact
// file with no awareness of (or gate on) which pipeline populated a given
// symbol's entry. Publishing foreign filers' P/E here, rather than into
// this script's own foreignPfcfCache.json (which nothing in the app reads
// for P/E), means zero app/client changes are needed for foreign-filer P/E
// to show up -- the existing, already-shipped P/E UI just starts finding
// real data for these tickers too. Deliberately NOT the same OUTPUT_FILE/
// cache object as P/FCF above -- P/FCF for foreign filers already has its
// own correct, working app-side fetch chain (fetchCachedForeignPfcfTrend
// reads foreignPfcfCache.json directly), so only the `.pe` key of each
// foreign ticker's entry in this file is ever touched; everything else
// (domestic tickers' entries in full, and any foreign ticker's own
// top-level ttm/quarterly/yearly P/FCF fields) is left completely alone.
const OUTPUT_PE_FILE = path.join(__dirname, '../pfcfTrendCache.json');
const GIST_PFCF_TREND_URL = 'https://gist.githubusercontent.com/jadrayes1/5cd7f459788725521246717b9e164a8e/raw/pfcfTrendCache.json';
// Published weekly by discoverForeignFilers.js (see that file's header) —
// read here so this job skips straight to its known ~374 candidates instead
// of re-checking ifrs-full for the full ~5,067-ticker universe every run.
// Verified live this matters: without it, this job was hitting its own
// 60-minute workflow timeout at ~68% through the full-universe scan, every
// single day for a week straight (confirmed via 7 consecutive "cancelled"
// runs) — so tickers landing later in iteration order (e.g. DHT) never got
// reached at all, not even once, since progress isn't persisted/resumed
// across runs either. Same fast path generateForeignFilingsCache.js already
// uses, just never carried over here when that fix was built.
const GIST_FOREIGN_FILER_LIST_URL = 'https://gist.githubusercontent.com/jadrayes1/5cd7f459788725521246717b9e164a8e/raw/foreignFilerList.json';
const SEC_TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';
const SEC_COMPANYFACTS_BASE = 'https://data.sec.gov/api/xbrl/companyfacts';
// SEC's fair-use policy asks for a descriptive User-Agent identifying the
// requester and a real contact — this is NOT an API key, just good-citizen
// identification; see https://www.sec.gov/os/webmaster-faq#developers
const SEC_USER_AGENT = 'stock-analyzer-app foreign-filings-pipeline contact:jadrayescpp@gmail.com';
const SEC_REQUEST_SPACING_MS = 200; // well under SEC's documented ~10 req/sec fair-use guidance
const TWELVEDATA_REQUEST_SPACING_MS = 8000; // ~7.5/min, under Twelve Data's free-tier 8/min cap
const QUARTERS_OF_HISTORY = 12; // mirrors src/utils/metrics.js
// Rotation budget -- see the priority/rotation comment at its call site
// for why this is needed now. Mirrors generatePfcfTrendCache.js's own
// constants, scaled to this workflow's 60-minute timeout (vs. that one's
// 7-hour budget) and this universe's smaller size (~769 vs 1,500+).
const MAX_TWELVEDATA_CALLS_PER_RUN = 700; // leaves buffer under Twelve Data's 800/day free-tier cap for this key
// Lowered from 50 to 40 minutes after a real 2026-09-22 incident: per-
// ticker cost has been climbing run over run (50 tickers/run on 09-19 ->
// 45 -> 32 -> 17) as the never-attempted queue increasingly consists of
// tickers needing the expensive filing-text-extraction fallback rather
// than a fast structured companyfacts call -- confirmed live via
// discoverForeignFilers.js's own foreignFilerList.json entries for BILI/
// CAN/NIU/VIPS/UXIN and 30+ other real tickers sitting at "never
// attempted" despite being sorted first in every run's priority queue.
// On 09-22 the 50-minute mark left too little headroom: the script's own
// loop didn't even reach its internal check before the workflow's hard
// 60-minute timeout killed the job outright -- verified via the run's own
// step timeline, where "Generate foreign P/FCF cache" itself shows
// conclusion "cancelled" and "Publish to gist" shows "skipped", meaning
// that entire run's 17 processed tickers (16 resolved) were computed and
// then silently discarded, never reaching the gist. A tighter budget
// can't fully fix a single ticker being slow, but it reliably leaves the
// install+publish steps (observed well under a minute in every normal
// run) enough room to still execute even on a day this bad.
const TIME_BUDGET_MS = 40 * 60 * 1000; // safety net alongside the call cap above; leaves headroom under the workflow's 60-minute timeout

function readTwelveDataApiKey() {
  if (process.env.TWELVEDATA_FOREIGN_PIPELINE_API_KEY) return process.env.TWELVEDATA_FOREIGN_PIPELINE_API_KEY;
  throw new Error('TWELVEDATA_FOREIGN_PIPELINE_API_KEY env var is not set.');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchSecJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': SEC_USER_AGENT, Accept: 'application/json' } });
  if (!res.ok) {
    if (res.status === 404) return null; // no CIK match / no facts filed — a normal outcome, not an error
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }
  return res.json();
}

// --- ADS ratio ----------------------------------------------------------
// The price is per US-listed share, but the share counts in a filer's XBRL
// are its ordinary shares. When each American Depositary Share stands for
// several ordinary shares, earnings per ordinary share divided into an ADS
// price overstates P/E and P/FCF by exactly that ratio -- verified live:
// PDD published P/E 41.5 against a real ~11 (one ADS = four Class A
// shares), BCS ~27 against ~7 (four), TSM 150 against ~25 (five). Read from
// the filer's latest 20-F, which states it in prose ("each ADS represents
// four ordinary shares"); checked against 26 known ADRs (2026-10-28),
// including fractional VIPS (0.2) and YMM (20). A ratio change is a split
// of the ADS, which the price series is already adjusted for, so the latest
// ratio applies to every period.
const NUMBER_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fifteen: 15, sixteen: 16, twenty: 20, thirty: 30, forty: 40, fifty: 50, hundred: 100,
};
const RATIO_NUMBER = `(\\d+(?:\\.\\d+)?|${Object.keys(NUMBER_WORDS).join('|')})(?:\\s*\\(\\d+\\))?`;
// Up to two words between the number and "shares": a class ("Class A",
// "20 B Shares" -- AMX) or the company's own name ("four Diageo ordinary
// shares" -- DEO).
const ORDINARY_SHARES = "(?:of\\s+(?:our|the company's)\\s+)?(?:[\\w.&'-]+\\s+){0,2}?(?:ordinary|common|equity|preferred)?\\s*shares?";
// "each representing the right to receive 20 B Shares" (AMX).
const REPRESENTS = '(?:represents?|representing|equals?|is equivalent to|corresponds to)(?:\\s+the right to receive)?';
const DEPOSITARY = '(?:american depositary (?:shares?|receipts?)|ads|adr)s?';
const ADS_RATIO_PATTERNS = [
  // "Each ADS represents", "Each B Share ADS represents" (AMX), "Each Diageo
  // ADS represents", "one ADR is equivalent to" (DEO).
  `(?:each|one|every)\\s+(?:[\\w.&'-]+\\s+){0,2}?${DEPOSITARY}\\s*(?:\\([^)]{0,20}\\))?,?\\s*${REPRESENTS}\\s+${RATIO_NUMBER}\\s+${ORDINARY_SHARES}`,
  // "ADSs, each representing two" -- after an aside as long as PBR's
  // "American Depositary Shares, or ADSs (evidenced by American Depositary
  // Receipts, or ADRs), each representing two Common Shares" -- and DEO's
  // "ADSs, representing four Diageo ordinary shares each".
  `(?:american depositary shares|adss)(?:\\s*,?\\s*or\\s+adss)?\\s*(?:\\([^)]{0,100}\\))?,?\\s*(?:each\\s+)?${REPRESENTS}\\s+${RATIO_NUMBER}\\s+${ORDINARY_SHARES}`,
  `${RATIO_NUMBER}\\s+(?:[\\w.&'-]+\\s+){0,2}?(?:ordinary|common)\\s+shares?\\s+(?:per|for each|represented by one|=)\\s*(?:one\\s+)?(?:american depositary share|ads)`,
];
function parseRatioNumber(text) {
  const t = text.toLowerCase().trim();
  if (NUMBER_WORDS[t] != null) return NUMBER_WORDS[t];
  const n = Number(t.replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Ordinary shares per ADS: 1 when the filer files no 20-F (40-F and us-gaap
// 10-K-style filers list their shares directly) or names no ratio (ASML,
// NVO: the listed share is the ordinary share); null when the 20-F names
// two ratios equally often, which the caller treats as "can't compute".
async function fetchAdsRatio(cik) {
  const submissions = await fetchSecJson(`https://data.sec.gov/submissions/CIK${cik}.json`);
  const r = submissions?.filings?.recent;
  const idx = r ? r.form.findIndex((f) => f === '20-F') : -1;
  if (idx < 0) return 1;
  // A filer that has since moved to 10-K reporting lists its shares directly
  // -- verified live: IXHL redomiciled to the US, and its last 20-F's "each
  // ADS = 25 shares" divided a 10-K share count by 25. recent[] is newest
  // first, so a 10-K at a lower index was filed after the 20-F.
  if (r.form.slice(0, idx).some((f) => f === '10-K')) return 1;
  await sleep(SEC_REQUEST_SPACING_MS);
  const url = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${r.accessionNumber[idx].replace(/-/g, '')}/${r.primaryDocument[idx]}`;
  const res = await fetch(url, { headers: { 'User-Agent': SEC_USER_AGENT } });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  const text = (await res.text())
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;|&#xa0;/gi, ' ')
    .replace(/\s+/g, ' ');
  const counts = new Map();
  for (const source of ADS_RATIO_PATTERNS) {
    const re = new RegExp(source, 'gi');
    let m;
    while ((m = re.exec(text))) {
      const v = parseRatioNumber(m[1]);
      if (v) counts.set(v, (counts.get(v) || 0) + 1);
    }
  }
  if (!counts.size) return 1;
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (ranked.length > 1 && ranked[0][1] === ranked[1][1]) return null;
  return ranked[0][0];
}

// --- Share splits -------------------------------------------------------
// Prices are split-adjusted to today's share basis; filed share counts are
// on whatever basis held when they were filed. A period's latest filing is
// restated after a split, but older periods never are -- verified live:
// BriaCell (BCTX) did a 1-for-15 and then a 1-for-10 reverse split, and its
// FY '22-'24 P/E (-43 to -66) used pre-split share counts against a price
// adjusted 150x, against a real ~-0.5; IXHL (1-for-30) likewise.
//
// Splits are read from the filer's own restatements: the same period's
// share count re-filed at a clean whole-number ratio (BCTX: 15,981,726 ->
// 1,065,448 = 15; 2,224,979 -> 222,498 = 10; across both, 150). Each split
// is pinned between the last filing on the old basis and the first on the
// new one. A restatement alone is not enough -- across all 1,109 foreign
// filers it also flags unit-tagging errors (AMX x1e-6 then x1e6), and a
// filer switching between ordinary and ADS-equivalent counts (PDD x927) --
// so each split must also show in the cover-page shares outstanding, which
// is always ordinary shares: some consecutive pair of cover counts in the
// window must move at least halfway toward the ratio (on a log scale) and
// end within 3x of it. 3x leaves room for heavy issuance: BCTX's cover
// count went 6.78M -> 1.88M across its 1-for-10 while it sold new shares.
// Real ratios seen run to 1-for-300 (BCTX 2020); larger is a unit error.
const MAX_SPLIT_RATIO = 300;

function cleanSplitFactor(older, newer) {
  if (!(older > 0 && newer > 0)) return null;
  const r = newer / older;
  const big = r >= 1 ? r : 1 / r;
  const n = Math.round(big);
  if (n < 2 || n > MAX_SPLIT_RATIO || Math.abs(big / n - 1) > 0.02) return null;
  return r >= 1 ? n : 1 / n;
}

function detectSplitEvents(sharesFacts, coverFacts = [], yahooSplits = []) {
  const byPeriod = new Map();
  for (const f of sharesFacts) {
    if (!f.start || !f.end || !f.filed || !(f.val > 0)) continue;
    const key = `${f.start}|${f.end}`;
    if (!byPeriod.has(key)) byPeriod.set(key, []);
    byPeriod.get(key).push(f);
  }
  const candidates = [];
  for (const facts of byPeriod.values()) {
    facts.sort((a, b) => a.filed.localeCompare(b.filed));
    for (let i = 1; i < facts.length; i++) {
      const prev = facts[i - 1];
      const cur = facts[i];
      if (cur.filed === prev.filed) continue;
      const factor = cleanSplitFactor(prev.val, cur.val);
      if (factor) candidates.push({ after: prev.filed, by: cur.filed, factor });
    }
  }
  // One event per ratio, pinned to the intersection of every window that
  // shows it. A ratio that is the product of two smaller ones (BCTX's 150)
  // is two splits seen across one window, not a third split.
  const groups = new Map();
  for (const c of candidates) {
    const key = c.factor.toPrecision(6);
    const g = groups.get(key);
    if (!g) groups.set(key, { ...c });
    else {
      if (c.after > g.after) g.after = c.after;
      if (c.by < g.by) g.by = c.by;
    }
  }
  const events = [];
  const sorted = [...groups.values()].sort((a, b) => Math.abs(Math.log(a.factor)) - Math.abs(Math.log(b.factor)));
  for (const g of sorted) {
    const isProduct = events.some((x, i) => events.some((y, j) => j > i && Math.abs(x.factor * y.factor / g.factor - 1) < 0.02));
    if (isProduct) continue;
    if (g.after >= g.by) continue; // windows that don't agree on when it happened -- not a clean split
    const cover = corroborateSplit(g, coverFacts);
    if (cover) {
      events.push({ ...g, after: cover.after, by: cover.by, miss: cover.miss });
      continue;
    }
    const listed = yahooSplits.find((y) => y.date > g.after && y.date <= g.by && Math.abs(y.factor / g.factor - 1) < 0.02);
    if (listed) events.push({ ...g, miss: 0 });
  }
  // Two ratios pinned to overlapping windows are one split seen through
  // dilution (TCOM 7 and 8) -- keep the one the cover count matches best.
  return events.filter((e) => !events.some((o) => o !== e && o.after < e.by && e.after < o.by && o.miss < e.miss));
}

// Total cover-page shares outstanding per filing (classes summed), oldest
// first; returns the narrowed window and how far off the ratio it was, or
// null when no consecutive pair in the window bears the split out.
function corroborateSplit(event, coverFacts) {
  const byAccession = new Map();
  for (const f of coverFacts) {
    if (!(f.val > 0) || !f.filed || !f.accn) continue;
    const g = byAccession.get(f.accn) || { filed: f.filed, val: 0 };
    g.val += f.val;
    byAccession.set(f.accn, g);
  }
  const points = [...byAccession.values()].sort((a, b) => a.filed.localeCompare(b.filed));
  const first = points.findIndex((p) => p.filed > event.after);
  const lastIdx = points.findIndex((p) => p.filed >= event.by);
  if (first < 1 || lastIdx < 0) return null;
  const want = Math.log(event.factor);
  let best = null;
  for (let i = first - 1; i < lastIdx; i++) {
    const got = Math.log(points[i + 1].val / points[i].val);
    if (Math.sign(got) !== Math.sign(want) || Math.abs(got) < Math.abs(want) / 2) continue;
    const miss = Math.abs(got - want);
    if (miss > Math.log(3)) continue;
    if (!best || miss < best.miss) best = { after: points[i].filed, by: points[i + 1].filed, miss };
  }
  if (!best) return null;
  // The cover pair can only narrow the restatement window, never move it.
  return { after: best.after > event.after ? best.after : event.after, by: best.by < event.by ? best.by : event.by, miss: best.miss };
}

// Yahoo's public chart endpoint lists split dates and ratios. It is the
// second witness for a restatement when the filer tags no cover-page share
// count (NVO's 2023 2-for-1), and the only source for a split after the
// newest filing, which has no restatement to read yet -- verified live:
// ZBAO's 1-for-50 took effect 2026-10-12, after its last filing, with its
// price already adjusted 50x. Never used alone for an earlier split: it has
// no record of BCTX's 1-for-15. Any failure just means an empty list.
async function fetchYahooSplits(symbol) {
  try {
    const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=max&interval=3mo&events=split`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    if (!res.ok) return [];
    const data = await res.json();
    const out = [];
    for (const sp of Object.values(data?.chart?.result?.[0]?.events?.splits || {})) {
      if (!(sp.numerator > 0 && sp.denominator > 0)) continue;
      const factor = sp.numerator / sp.denominator; // shares after per share before
      const n = factor >= 1 ? factor : 1 / factor;
      if (Math.abs(n - Math.round(n)) > 1e-9 || Math.round(n) < 2) continue;
      out.push({ date: new Date(sp.date * 1000).toISOString().slice(0, 10), factor });
    }
    return out;
  } catch {
    return [];
  }
}

// A share count 300x or more away from every neighbouring period is a unit
// error, never a real change -- splits are already adjusted out by then,
// and no issuance or buyback moves a count that far in one period. Verified
// live: PDD's FY2022 count came from a filing tagged in thousands, giving
// P/E 0.03. Dropped rather than rescaled: which side is wrong isn't known.
function dropShareOutliers(points) {
  const sorted = [...points].sort((a, b) => a.end.localeCompare(b.end));
  const far = (a, b) => Math.abs(Math.log(a / b)) >= Math.log(300);
  return sorted.filter((p, i) => {
    const neighbours = [sorted[i - 1], sorted[i + 1]].filter((n) => n && n.value > 0);
    if (!neighbours.length || !(p.value > 0)) return true;
    return !neighbours.every((n) => far(p.value, n.value));
  });
}

// Puts every share count on today's basis: multiplied by each later split's
// factor. A count filed between the last old-basis filing and the first
// new-basis one could be either, so it is dropped; a count with no filing
// date is left as it is.
function splitAdjust(facts, events) {
  if (!events.length) return facts;
  const out = [];
  for (const f of facts) {
    if (!f.filed) {
      out.push(f);
      continue;
    }
    let factor = 1;
    let ambiguous = false;
    for (const e of events) {
      if (f.filed <= e.after) factor *= e.factor;
      else if (f.filed < e.by) ambiguous = true;
    }
    if (ambiguous) continue;
    out.push(factor === 1 ? f : { ...f, val: f.val * factor });
  }
  return out;
}

async function fetchTickerToCikMap() {
  const data = await fetchSecJson(SEC_TICKERS_URL);
  const map = new Map();
  for (const entry of Object.values(data || {})) {
    if (entry?.ticker && entry?.cik_str != null) {
      map.set(String(entry.ticker).toUpperCase(), String(entry.cik_str).padStart(10, '0'));
    }
  }
  return map;
}

// Ten years: one credit per request whatever the length, and a period
// older than the price history can never be recomputed -- verified live:
// with 48 months, BCTX's FY '22 P/E (-43, from pre-split share counts)
// stayed published through every fix, since no run could produce it again.
const PRICE_HISTORY_MONTHS = 120;

async function fetchMonthlyPrices(symbol, apiKey) {
  const res = await fetch(`https://api.twelvedata.com/time_series?symbol=${symbol}&interval=1month&outputsize=${PRICE_HISTORY_MONTHS}&apikey=${apiKey}`);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching Twelve Data prices for ${symbol}`);
  const data = await res.json();
  if (data?.status !== 'ok' || !Array.isArray(data.values)) return [];
  return data.values.map((v) => ({ date: v.datetime, close: parseFloat(v.close) })).filter((v) => !Number.isNaN(v.close));
}

// ---------------------------------------------------------------------------
// IFRS concept extraction — same concepts/verification as
// generateForeignFilingsCache.js (OCF/Capex already used there for FCF
// Margin; Shares is defined there but unused until now).
// ---------------------------------------------------------------------------

// us-gaap equivalents added alongside the original ifrs-full-only concepts
// -- verified live: 395 of 769 known foreign filers (51%) are us-gaap
// filers (see discoverForeignFilers.js's own taxonomy field), and this
// script's isForeignFiler gate below was rejecting every one of them outright
// regardless of these concept lists -- but even with that gate fixed, none
// of them would have matched here either, since 'CashFlowsFromUsedIn
// OperatingActivities' and the two Purchase* concepts are IFRS-only
// terminology. Mirrors OCF_CONCEPTS/CAPEX_CONCEPTS/SHARES_CONCEPTS in
// generateForeignFilingsCache.js exactly -- this script never got the
// us-gaap classification expansion that landed there earlier, the same
// "fast path never carried over" gap already documented above for
// GIST_FOREIGN_FILER_LIST_URL.
const OCF_CONCEPTS = ['CashFlowsFromUsedInOperatingActivities', 'NetCashProvidedByUsedInOperatingActivities', 'NetCashProvidedByUsedInOperatingActivitiesContinuingOperations'];
const CAPEX_CONCEPTS = [
  'PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities',
  'PurchaseOfPropertyPlantAndEquipmentIntangibleAssetsOtherThanGoodwillInvestmentPropertyAndOtherNoncurrentAssets',
  'PaymentsToAcquirePropertyPlantAndEquipment',
  'PaymentsToAcquireProductiveAssets',
  'PaymentsForCapitalImprovements',
  'PaymentsToAcquireOtherPropertyPlantAndEquipment',
];
const SHARES_CONCEPTS = ['WeightedAverageShares', 'WeightedAverageNumberOfSharesOutstandingBasic', 'WeightedAverageNumberOfDilutedSharesOutstanding'];
// For P/E's numerator -- mirrors NET_INCOME_CONCEPTS in
// generateForeignFilingsCache.js exactly (ProfitLoss is the ifrs-full
// concept, NetIncomeLoss the us-gaap one, same dual-taxonomy pattern as
// every other concept list in this file).
const NET_INCOME_CONCEPTS = ['ProfitLoss', 'NetIncomeLoss'];

// Merges facts across every matching concept rather than short-circuiting
// on the first one -- see generateForeignFilingsCache.js's own copy of
// this function for the full rationale (verified live for IMPP: it
// switches which XBRL concept it tags capex under between early 6-K
// filings and its 20-F annual reports).
//
// `unit`, when given, keeps only facts in that unit. Monetary concepts need
// it: a filer that tags its own currency AND a USD convenience translation
// (ZBAO: CNY plus USD for the latest year) otherwise gets both merged into
// one series, and the unconverted native figures divided by a USD price --
// verified live: MGN's P/E published as 143,277 (MYR net income over a USD
// price) instead of 29.4, ZBAO's exactly 6.9x off. Share counts carry a
// single 'shares' unit and are left unfiltered.
function extractFactSeries(companyFacts, conceptCandidates, unit = null) {
  const merged = [];
  for (const taxonomy of ['ifrs-full', 'us-gaap']) {
    const facts = companyFacts?.facts?.[taxonomy];
    if (!facts) continue;
    for (const concept of conceptCandidates) {
      const entry = facts[concept];
      if (!entry?.units) continue;
      for (const [entryUnit, unitFacts] of Object.entries(entry.units)) {
        if (unit && entryUnit !== unit) continue;
        if (Array.isArray(unitFacts) && unitFacts.length) merged.push(...unitFacts);
      }
    }
  }
  return merged;
}

// The one currency this filer's monetary series are read in: whichever unit
// carries the most net income / OCF / capex facts. A convenience USD
// translation covers a year or two, so it never outvotes the reporting
// currency; a USD reporter's stray native-currency fact never outvotes USD.
function detectReportingCurrency(companyFacts) {
  const counts = new Map();
  for (const taxonomy of ['ifrs-full', 'us-gaap']) {
    const facts = companyFacts?.facts?.[taxonomy];
    if (!facts) continue;
    for (const concept of [...NET_INCOME_CONCEPTS, ...OCF_CONCEPTS, ...CAPEX_CONCEPTS]) {
      for (const [unit, unitFacts] of Object.entries(facts[concept]?.units || {})) {
        counts.set(unit, (counts.get(unit) || 0) + (Array.isArray(unitFacts) ? unitFacts.length : 0));
      }
    }
  }
  if (!counts.size) return 'USD';
  return [...counts.entries()].reduce((best, cur) => (cur[1] > best[1] || (cur[1] === best[1] && cur[0] === 'USD') ? cur : best))[0];
}

// Converts a classified {quarterly, annual} series to USD, each point at
// the average rate over its own [start, end] -- the same convention
// convertNativeCurrencyToUsd documents for TSM. Done once, after every
// source (XBRL, 20-F, 6-K text) has been merged and the quarters derived,
// so the 6-K extractor's scale detection still compares like with like
// (native figures against native annual anchors). A point with no rate is
// dropped, never published unconverted; a currency with no verified FRED
// series (PEN, ILS...) therefore produces no P/FCF or P/E at all.
async function convertSeriesToUsd(series, currency) {
  if (currency === 'USD') return series;
  const convert = async (points) => {
    const out = [];
    for (const p of points) {
      const value = await convertNativeCurrencyToUsd(p.value, currency, { start: p.start, end: p.end });
      if (value != null && Number.isFinite(value)) out.push({ ...p, value });
    }
    return out;
  };
  return { quarterly: await convert(series.quarterly), annual: await convert(series.annual) };
}

function daysBetween(startStr, endStr) {
  const start = new Date(startStr);
  const end = new Date(endStr);
  return (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24);
}

// A 52/53-week filer's period closes on a fixed weekday, so it can end a
// few days INTO the next month (TDY's FY2022 ended 2023-01-01; SWK's
// quarters end Apr 4 / Jul 4 / Oct 3). Labelled straight from that date it
// lands a whole quarter late and collides with the real next period under
// the same label, one value overwriting the other -- verified live: TDY's
// yearly ROIC skipped FY '13/'15/'20, SWK's skipped FY '20/'25 and Q4 '25,
// and the 2026-10-23 P/FCF recompute dropped KELYA/TDY FY '22. Backdated
// QUARTER_LABEL_BACKDATE_DAYS first, the same rule (and the same 5 days)
// as generateForeignFilingsCache.js's quarterLabelFromPeriod, which found it on
// ASML; every ordinary month-end stays in its own quarter.
const QUARTER_LABEL_BACKDATE_DAYS = 5;
function quarterLabelFromDate(dateStr) {
  const raw = new Date(dateStr);
  if (Number.isNaN(raw.getTime())) return null;
  const d = new Date(raw.getTime() - QUARTER_LABEL_BACKDATE_DAYS * 24 * 60 * 60 * 1000);
  const q = Math.floor(d.getUTCMonth() / 3) + 1;
  return `Q${q} '${String(d.getUTCFullYear()).slice(-2)}`;
}

function annualLabelFromDate(dateStr) {
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return null;
  return `FY '${String(d.getUTCFullYear()).slice(-2)}`;
}

// Same dedupe-by-(start,end)-then-classify-by-duration-then-de-cumulate
// logic as generateForeignFilingsCache.js's dedupeAndClassify — see that
// file's own comment for the full rationale (more than half of this
// pipeline's covered universe reports interim results as YTD-cumulative
// 6-month/9-month figures rather than tagging standalone quarters
// directly; de-cumulating those recovers real Quarterly/TTM coverage that
// was previously silently dropped). Kept as its own copy (CommonJS, not
// part of the app's ES module bundle) rather than requiring across the
// two scripts.
// "shares" is a point-in-time snapshot, not a flow -- unlike ocf/capex, it
// is never valid to derive a "missing quarter's" share count as (a longer
// cumulative period's value minus a shorter one), the same principle
// already fixed in extractFilingTextFacts.js's own reconcilePoints (see
// NON_ADDITIVE_CONCEPTS there). This script keeps its OWN separate copy of
// this H1/9mo/FY decumulation logic (for its own capex sign-handling and
// TARGET_SYMBOL-scoped rotation), so the same fix has to be applied here
// too -- verified live: DHT's real Q3 share counts (a plausible ~140-167
// million each) were correct, but every derived "Q4" came out as a huge,
// often-negative nonsense value from subtracting mismatched period shapes.
const NON_ADDITIVE_CONCEPTS = new Set(['shares']);

function dedupeAndClassify(rawFacts, concept) {
  const byPeriod = new Map();
  for (const fact of rawFacts) {
    const value = fact.val;
    if (value == null || !fact.start || !fact.end) continue;
    const key = `${fact.start}|${fact.end}`;
    const existing = byPeriod.get(key);
    if (!existing || new Date(fact.filed) > new Date(existing.filed)) {
      byPeriod.set(key, fact);
    }
  }

  let quarterly = [];
  let h1 = [];
  let q3ytd = [];
  let annual = [];
  for (const fact of byPeriod.values()) {
    const days = daysBetween(fact.start, fact.end);
    const point = { start: fact.start, end: fact.end, value: fact.val };
    if (days >= 80 && days <= 100) quarterly.push(point);
    else if (days >= 170 && days <= 200) h1.push(point);
    else if (days >= 260 && days <= 300) q3ytd.push(point);
    else if (days >= 350 && days <= 380) annual.push(point);
  }

  // A second, narrower dedup pass -- the byPeriod dedup above keys on
  // EXACT start|end, which two independent sources can legitimately
  // disagree on for the SAME real quarter (verified live for DHT: a raw
  // XBRL Q3 fact and its 6-K-extracted counterpart landed one calendar day
  // apart on `start`, surviving the exact-key dedup as two "different"
  // points with the same value, showing the same quarter twice in
  // published output). Deduping by END DATE ALONE would be unsafe done
  // globally, but safe here specifically because it's applied WITHIN each
  // already-duration-classified bucket, where every member has already
  // passed the same 80-100/170-200/260-300/350-380-day filter -- same fix
  // already shipped in generateForeignFilingsCache.js's own copy of this
  // function, never carried over here.
  const dedupeByEnd = (points) => {
    const byEnd = new Map();
    for (const p of points) if (!byEnd.has(p.end)) byEnd.set(p.end, p);
    return Array.from(byEnd.values());
  };
  quarterly = dedupeByEnd(quarterly);
  h1 = dedupeByEnd(h1);
  q3ytd = dedupeByEnd(q3ytd);
  annual = dedupeByEnd(annual);

  if (NON_ADDITIVE_CONCEPTS.has(concept)) {
    quarterly.sort((a, b) => new Date(a.end) - new Date(b.end));
    annual.sort((a, b) => new Date(a.end) - new Date(b.end));
    return { quarterly, annual };
  }

  const hasEnd = (end) => quarterly.some((q) => q.end === end);
  // Approximate (not exact-string) start match -- verified live this
  // matters: IMPP's real standalone Q1 fact and its real H1 fact (from
  // DIFFERENT filings) each synthesize their own `start` via
  // subtractMonths from their own real end dates, landing one calendar day
  // apart purely from month-length arithmetic despite representing the
  // exact same real fiscal-year start -- an exact Map.get(start) lookup
  // never finds the match, so H1-Q1 (and the same-shaped 9mo-H1/FY-9mo)
  // derivations silently never fire. Same fix already shipped in
  // generateForeignFilingsCache.js's own copy of this function (found via
  // IMPP), never carried over here -- confirmed live this is CNI's own
  // remaining P/FCF blocker too (its real capex Q1 end="2023-03-31" vs H1
  // start="2023-03-30", one day apart).
  const findByApproxStart = (points, targetStart) => points.find((p) => Math.abs(daysBetween(p.start, targetStart)) <= 5);

  for (const h of h1) {
    const q1 = findByApproxStart(quarterly, h.start);
    if (q1 && !hasEnd(h.end)) quarterly.push({ start: q1.end, end: h.end, value: h.value - q1.value });
  }
  for (const q3 of q3ytd) {
    const half = findByApproxStart(h1, q3.start);
    if (half && !hasEnd(q3.end)) quarterly.push({ start: half.end, end: q3.end, value: q3.value - half.value });
  }
  for (const fy of annual) {
    const q3 = findByApproxStart(q3ytd, fy.start);
    if (q3 && !hasEnd(fy.end)) quarterly.push({ start: q3.end, end: fy.end, value: fy.value - q3.value });
  }

  quarterly.sort((a, b) => new Date(a.end) - new Date(b.end));
  annual.sort((a, b) => new Date(a.end) - new Date(b.end));
  return { quarterly, annual };
}

function isAdjacent(prevEnd, currStart) {
  const gapDays = daysBetween(prevEnd, currStart);
  return gapDays >= -5 && gapDays <= 5;
}

function buildTrailingWindows(standaloneQuarters, maxSize = 4) {
  return standaloneQuarters.map((anchor, i) => {
    const window = [anchor];
    for (let j = i - 1; j >= 0 && window.length < maxSize; j--) {
      if (isAdjacent(standaloneQuarters[j].end, window[0].start)) {
        window.unshift(standaloneQuarters[j]);
      } else {
        break;
      }
    }
    return { quarters: window, anchor, partial: window.length < maxSize };
  });
}

// No MAX_ABS_RATIO/clampImplausible here — P/FCF is a valuation MULTIPLE,
// not a percentage, so the same 1000%-style sanity bound the other foreign-
// filer metrics use doesn't apply, matching stock-metrics-pipeline's own
// generatePfcfTrendCache.js (which deliberately skips that clamp too).

// Named for OCF (P/FCF's own numerator, where this was first found and
// fixed) but genuinely flow-agnostic -- reused below for net income (P/E's
// numerator), which has the exact same risk: a text-extracted income-
// statement figure with no annual XBRL anchor is just as unverifiable in
// scale as a cash-flow-statement one, from the SAME underlying cause
// (detectScaleMultiplier needs an annual anchor to calibrate against,
// regardless of which concept is being extracted).
//
// A text-extracted OCF figure's UNIT SCALE can't always be verified via
// detectScaleMultiplier (extractFilingTextFacts.js) -- that requires a real
// annual XBRL anchor to calibrate against, which some filers (verified
// live: STNG) simply don't have for OCF/capex at all. With no evidence,
// detectScaleMultiplier silently defaults to scale=1 -- an ASSUMPTION, not
// a verified fact. STNG's real cash-flow-statement table is denominated
// "$ in thousands" (a standard convention), but its share count is stated
// in full (also standard -- share counts aren't abbreviated the way dollar
// figures are) -- so the same batch-wide scale detection that correctly
// leaves shares alone (scale=1 happens to be right there) silently leaves
// OCF/capex 1000x too small too, since nothing in that batch catches the
// mismatch. This is invisible to fcfMargin (OCF/capex divided by revenue,
// extracted from the SAME table at the SAME wrong scale -- the ratio
// cancels the error out) but catastrophic for P/FCF specifically, which
// divides by an independently-and-correctly-scaled share count: a
// 1000x-too-small OCF produces a 1000x-too-LARGE P/FCF (verified live:
// STNG's Q1 2024 quarterly P/FCF published as 4149.14 -- at the real
// ~$70 share price and ~50M real shares, the implied OCF is $222,130,
// i.e. 0.006% of market cap; the same row scaled correctly per its own
// table convention (x1000) would be $222.13M, a normal 6.3% of market cap).
//
// Since there's no annual anchor to verify the TRUE scale from, this
// deliberately does NOT attempt to guess/apply a correction (that would be
// exactly the kind of fabrication this pipeline avoids everywhere else) --
// it only detects when the CURRENT (unverified, assumed-1x) scale is
// implausible enough that the resulting flow can't be real, and declines
// to publish that point at all, same "verify or leave empty" principle as
// everywhere else in this pipeline. A real quarterly OCF this far below
// market cap has never been observed for an operating company at any
// scale -- even a distressed one -- so a wide margin (fractions of a
// basis point) comfortably avoids false positives against genuinely thin
// (but real) cash flow. The annual threshold is 4x the quarterly one,
// matching the natural ~4x larger magnitude of a full year's flow vs one
// quarter's -- using the same threshold for both would fail to catch an
// annual-cadence version of the identical scale error (a 1000x-too-small
// annual OCF still clears the quarterly-sized bar on its own).
const MIN_PLAUSIBLE_OCF_FRACTION_OF_MARKET_CAP = 0.0001; // 1 basis point, quarterly-flow-sized
const MIN_PLAUSIBLE_ANNUAL_OCF_FRACTION_OF_MARKET_CAP = 0.0004; // 4 basis points, annual-flow-sized

function isOcfScalePlausible(ocfValue, price, shares, threshold = MIN_PLAUSIBLE_OCF_FRACTION_OF_MARKET_CAP) {
  if (price == null || !(shares > 0)) return true; // nothing to check against -- don't block on missing inputs
  const marketCap = price * shares;
  if (!(marketCap > 0)) return true;
  return Math.abs(ocfValue) >= threshold * marketCap;
}

const MAX_PRICE_MATCH_MS = 45 * 24 * 60 * 60 * 1000;

function findClosestMonthlyPrice(monthlyPrices, targetDateStr) {
  const targetDate = new Date(targetDateStr);
  if (!monthlyPrices?.length || Number.isNaN(targetDate.getTime())) return null;
  let closest = null;
  let closestDiff = Infinity;
  for (const p of monthlyPrices) {
    const diff = Math.abs(new Date(p.date).getTime() - targetDate.getTime());
    if (diff < closestDiff) {
      closestDiff = diff;
      closest = p;
    }
  }
  return closest && closestDiff <= MAX_PRICE_MATCH_MS ? closest.close : null;
}

// Shares outstanding moves slowly (barely at all quarter to quarter for a
// filer without frequent buybacks/issuances) but isn't always disclosed
// every quarter -- verified live: DHT's native XBRL only ever tags a
// matchable share count for Q3 of each year, even though its OCF/capex
// (via the 6-K/20-F fallbacks) now cover all four quarters. A strict
// exact-end-date join would silently drop Q1/Q2/Q4 P/FCF entirely despite
// every other input being real and available. Carries forward the nearest
// REAL disclosed share count within ~200 days (a bit under a year -- wide
// enough to bridge one missing quarter between two real annual-cadence
// disclosures, narrow enough that a genuinely stale count never gets used
// for a filer this doesn't apply to). Same "reuse a real, recently-
// disclosed value across nearby periods when the metric doesn't fluctuate
// much" approach already used for WEYS's annual shares fallback in the
// main pipeline's generatePfcfTrendCache.js.
const MAX_SHARES_CARRY_FORWARD_MS = 200 * 24 * 60 * 60 * 1000;

function findNearestShares(sharesQuarterly, targetEndDate) {
  const target = new Date(targetEndDate);
  if (!sharesQuarterly?.length || Number.isNaN(target.getTime())) return null;
  let closest = null;
  let closestDiff = Infinity;
  for (const s of sharesQuarterly) {
    const diff = Math.abs(new Date(s.end).getTime() - target.getTime());
    if (diff < closestDiff) {
      closestDiff = diff;
      closest = s;
    }
  }
  return closest && closestDiff <= MAX_SHARES_CARRY_FORWARD_MS ? closest.value : null;
}

// ---------------------------------------------------------------------------
// P/FCF builders — mirror buildPfcfTrendFromFilingsAndPrices/
// buildPfcfQuarterlyFromFilingsAndPrices/buildPfcfYearlyFromFilingsAndPrices
// in the main app's src/utils/metrics.js (same annualization/windowing
// logic), adapted to this file's end-date-keyed point shape.
// ---------------------------------------------------------------------------

function buildForeignPfcfTTM(ocfQuarterly, capexQuarterly, sharesQuarterly, monthlyPrices) {
  const capexByEnd = new Map(capexQuarterly.map((c) => [c.end, c.value]));
  const sharesByEnd = new Map(sharesQuarterly.map((s) => [s.end, s.value]));
  const standalone = ocfQuarterly
    .map((o) => ({ ...o, shares: sharesByEnd.get(o.end) ?? findNearestShares(sharesQuarterly, o.end) }))
    .filter((o) => capexByEnd.has(o.end) && o.shares > 0)
    .map((o) => ({ start: o.start, end: o.end, ocf: o.value, fcf: o.value - capexByEnd.get(o.end), shares: o.shares }));

  return buildTrailingWindows(standalone, 4)
    .map(({ quarters, anchor, partial }) => {
      const price = findClosestMonthlyPrice(monthlyPrices, anchor.end);
      if (!isOcfScalePlausible(anchor.ocf, price, anchor.shares)) return null;
      // Annualized when the window is PARTIAL -- see the identical note in
      // stock-metrics-pipeline's generatePfcfTrendCache.js. A valuation
      // ratio divides a whole share price by a period's flow, so a 1-3
      // quarter window inflates it ~4x/2x/1.33x. Verified live: ASML read
      // Q4'23=130.9(q1,partial) through Q2'24=157.7(q3,partial), snapping
      // to 92.1 and 32.0 once full, against a FY'23 yearly P/FCF of 104.2.
      // The margin builders correctly leave partial windows unscaled,
      // because there both numerator and denominator cover the same
      // quarters; only a ratio against a full PRICE needs this.
      const ttmFcf = quarters.reduce((sum, q) => sum + q.fcf, 0) * (4 / quarters.length);
      const ttmFcfPerShare = ttmFcf / anchor.shares;
      const value = price != null && ttmFcfPerShare !== 0 ? price / ttmFcfPerShare : null;
      return value != null ? { label: quarterLabelFromDate(anchor.end), value, partial, quartersUsed: quarters.length } : null;
    })
    .filter(Boolean)
    .slice(-QUARTERS_OF_HISTORY);
}

// Standalone (non-TTM) quarterly P/FCF — annualized (x4), not the raw
// single-quarter FCF, same reasoning as stock-metrics-pipeline's identical
// builder: P/FCF's convention divides price by a full YEAR of cash flow.
function buildForeignPfcfQuarterly(ocfQuarterly, capexQuarterly, sharesQuarterly, monthlyPrices) {
  const capexByEnd = new Map(capexQuarterly.map((c) => [c.end, c.value]));
  const sharesByEnd = new Map(sharesQuarterly.map((s) => [s.end, s.value]));
  return ocfQuarterly
    .map((o) => ({ ...o, shares: sharesByEnd.get(o.end) ?? findNearestShares(sharesQuarterly, o.end) }))
    .filter((o) => capexByEnd.has(o.end) && o.shares > 0)
    .map((o) => {
      const price = findClosestMonthlyPrice(monthlyPrices, o.end);
      if (!isOcfScalePlausible(o.value, price, o.shares)) return null;
      const annualizedFcfPerShare = ((o.value - capexByEnd.get(o.end)) / o.shares) * 4;
      const value = price != null && annualizedFcfPerShare !== 0 ? price / annualizedFcfPerShare : null;
      return value != null ? { label: quarterLabelFromDate(o.end), value } : null;
    })
    .filter(Boolean)
    .slice(-QUARTERS_OF_HISTORY);
}

// One P/FCF point per fiscal year, priced at that year's own period-end close.
function buildForeignPfcfYearly(ocfAnnual, capexAnnual, sharesAnnual, monthlyPrices) {
  const capexByEnd = new Map(capexAnnual.map((c) => [c.end, c.value]));
  const sharesByEnd = new Map(sharesAnnual.map((s) => [s.end, s.value]));
  // dedupeAndClassify deliberately CAN return multiple entries for the same
  // end-date (the same real annual figure independently disclosed in two
  // different filings, kept for cross-filing corroboration elsewhere in
  // this pipeline) -- every other call site that turns *Annual into a
  // per-period lookup already collapses this via a Map (see capexByEnd/
  // sharesByEnd just above, and the `annualByEnd` Maps built throughout
  // this file). This function was the one place still iterating ocfAnnual
  // directly, so two real facts for the same year produced two duplicate-
  // labeled output points. Verified live: QGEN, once its extraction
  // improved enough to have multiple corroborated annual OCF facts,
  // started publishing "FY '23"/"FY '24"/"FY '25" twice each.
  const ocfByEnd = new Map(ocfAnnual.map((o) => [o.end, o.value]));
  return [...ocfByEnd.entries()]
    .map(([end, value]) => ({ end, value }))
    .filter((o) => capexByEnd.has(o.end) && sharesByEnd.get(o.end) > 0)
    .map((o) => {
      const shares = sharesByEnd.get(o.end);
      const price = findClosestMonthlyPrice(monthlyPrices, o.end);
      if (!isOcfScalePlausible(o.value, price, shares, MIN_PLAUSIBLE_ANNUAL_OCF_FRACTION_OF_MARKET_CAP)) return null;
      const fcfPerShare = (o.value - capexByEnd.get(o.end)) / shares;
      const value = price != null && fcfPerShare !== 0 ? price / fcfPerShare : null;
      return value != null ? { label: annualLabelFromDate(o.end), value } : null;
    })
    .filter(Boolean)
    .slice(-QUARTERS_OF_HISTORY);
}

// ---------------------------------------------------------------------------
// P/E builders — mirror the P/FCF trio above exactly (buildForeignPfcfTTM/
// Quarterly/Yearly), with net income/shares (EPS) in place of
// (ocf-capex)/shares. Deliberately NO clamp against negative values --
// unlike a scale-detection failure (which produces an impossible ratio the
// isOcfScalePlausible check below catches), a real net LOSS legitimately
// produces a negative P/E, and surfacing exactly that is the whole point:
// the domestic pipeline's own P/E reconstruction (generatePfcfTrendCache.js)
// was built because Finnhub's native P/E series was verified to
// systematically omit negative-EPS periods for unprofitable companies --
// same reasoning applies here, unchanged.
//
// Published into pfcfTrendCache.json (see GIST_PFCF_TREND_URL's own
// comment), NOT this script's own foreignPfcfCache.json -- so the app's
// existing, already-shipped fetchCachedPeTrend just starts finding real
// data for these tickers with zero client changes.
// ---------------------------------------------------------------------------

function buildForeignPeTTM(netIncomeQuarterly, sharesQuarterly, monthlyPrices) {
  const sharesByEnd = new Map(sharesQuarterly.map((s) => [s.end, s.value]));
  const standalone = netIncomeQuarterly
    .map((n) => ({ ...n, shares: sharesByEnd.get(n.end) ?? findNearestShares(sharesQuarterly, n.end) }))
    .filter((n) => n.shares > 0)
    .map((n) => ({ start: n.start, end: n.end, netIncome: n.value, shares: n.shares }));

  return buildTrailingWindows(standalone, 4)
    .map(({ quarters, anchor, partial }) => {
      const price = findClosestMonthlyPrice(monthlyPrices, anchor.end);
      if (!isOcfScalePlausible(anchor.netIncome, price, anchor.shares)) return null;
      // Annualized when the window is PARTIAL -- see the identical note in
      // stock-metrics-pipeline's generatePfcfTrendCache.js. A valuation
      // ratio divides a whole share price by a period's flow, so a 1-3
      // quarter window inflates it ~4x/2x/1.33x. Verified live: ASML read
      // Q4'23=130.9(q1,partial) through Q2'24=157.7(q3,partial), snapping
      // to 92.1 and 32.0 once full, against a FY'23 yearly P/FCF of 104.2.
      // The margin builders correctly leave partial windows unscaled,
      // because there both numerator and denominator cover the same
      // quarters; only a ratio against a full PRICE needs this.
      const ttmNetIncome = quarters.reduce((sum, q) => sum + q.netIncome, 0) * (4 / quarters.length);
      const ttmEps = ttmNetIncome / anchor.shares;
      const value = price != null && ttmEps !== 0 ? price / ttmEps : null;
      return value != null ? { label: quarterLabelFromDate(anchor.end), value, partial, quartersUsed: quarters.length } : null;
    })
    .filter(Boolean)
    .slice(-QUARTERS_OF_HISTORY);
}

// Standalone (non-TTM) quarterly P/E -- annualized (x4) EPS, same
// convention as buildForeignPfcfQuarterly above.
function buildForeignPeQuarterly(netIncomeQuarterly, sharesQuarterly, monthlyPrices) {
  const sharesByEnd = new Map(sharesQuarterly.map((s) => [s.end, s.value]));
  return netIncomeQuarterly
    .map((n) => ({ ...n, shares: sharesByEnd.get(n.end) ?? findNearestShares(sharesQuarterly, n.end) }))
    .filter((n) => n.shares > 0)
    .map((n) => {
      const price = findClosestMonthlyPrice(monthlyPrices, n.end);
      if (!isOcfScalePlausible(n.value, price, n.shares)) return null;
      const annualizedEps = (n.value / n.shares) * 4;
      const value = price != null && annualizedEps !== 0 ? price / annualizedEps : null;
      return value != null ? { label: quarterLabelFromDate(n.end), value } : null;
    })
    .filter(Boolean)
    .slice(-QUARTERS_OF_HISTORY);
}

// One P/E point per fiscal year, priced at that year's own period-end
// close -- mirrors buildForeignPfcfYearly above.
function buildForeignPeYearly(netIncomeAnnual, sharesAnnual, monthlyPrices) {
  const sharesByEnd = new Map(sharesAnnual.map((s) => [s.end, s.value]));
  const netIncomeByEnd = new Map(netIncomeAnnual.map((n) => [n.end, n.value]));
  return [...netIncomeByEnd.entries()]
    .map(([end, value]) => ({ end, value }))
    .filter((n) => sharesByEnd.get(n.end) > 0)
    .map((n) => {
      const shares = sharesByEnd.get(n.end);
      const price = findClosestMonthlyPrice(monthlyPrices, n.end);
      if (!isOcfScalePlausible(n.value, price, shares, MIN_PLAUSIBLE_ANNUAL_OCF_FRACTION_OF_MARKET_CAP)) return null;
      const eps = n.value / shares;
      const value = price != null && eps !== 0 ? price / eps : null;
      return value != null ? { label: annualLabelFromDate(n.end), value } : null;
    })
    .filter(Boolean)
    .slice(-QUARTERS_OF_HISTORY);
}

// Turns a published label ("Q1 '24", "FY '24") into a comparable ordinal
// for sorting a merged trend back into chronological order. Quarterly
// ordinals are year*4+quarter; annual labels get year*4 (never actually
// compared against quarterly ones -- ttm/quarterly and yearly are always
// separate arrays -- but a consistent scale costs nothing).
function parseLabelToOrdinal(label) {
  const q = /^Q(\d) '(\d\d)$/.exec(label || '');
  if (q) return (2000 + Number(q[2])) * 4 + Number(q[1]);
  const fy = /^FY '(\d\d)$/.exec(label || '');
  if (fy) return (2000 + Number(fy[1])) * 4;
  return null;
}

// A fresh attempt can come back empty, narrower, or (as verified live for
// DHT this session) subtly WRONG on a day where extraction/reconciliation
// hits an edge case -- a previous version of this function replaced the
// ENTIRE existing array the moment fresh contained even one label the
// existing one didn't, on the theory that fresh is normally a superset.
// Verified live that assumption doesn't always hold: a single genuinely
// new label (e.g. one more recent quarter finally reconciling) could ride
// along with several OTHER, independently-wrong values from the same bug,
// silently overwriting real previously-published quarters with wrong ones
// even though the guarantee was meant to be "never regress to narrower."
// This is a real UNION instead: every existing point is kept forever
// (never dropped, never overwritten by a fresh value for the same label),
// and fresh only ever contributes labels that aren't already published.
// Merged result re-sorted chronologically (a genuinely new label can be
// OLDER than some already-published ones -- this session's own gap-
// backfill fixes routinely recovered previously-missing OLDER quarters,
// not just more recent ones) and re-capped at the same rolling-window
// size the builders themselves use, so the window still ages out its
// oldest quarter as newer ones arrive rather than growing without bound.
// Metrics this run may REPLACE rather than union-protect (pfcfRatio and/or
// peRatio) -- the same opt-in as RECOMPUTE_METRICS in
// generateForeignFilingsCache.js, which carries the full rationale. The
// union above drops any corrected value whose label is already published:
// verified, the partial-TTM-window annualization (commit 6b86641) can
// never reach a published point without this.
const RECOMPUTE_METRICS = new Set(
  (process.env.RECOMPUTE_METRICS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
);

// Set by the workflow only for a scheduled recompute sweep (see its "Resolve
// recompute sweep" step): the sweep's start. A ticker refreshed since then
// has already been recomputed once and is merged normally from here on.
const SWEEP_SINCE = process.env.SWEEP_SINCE ? Date.parse(process.env.SWEEP_SINCE) : null;
function alreadySwept(fetchedAt) {
  return SWEEP_SINCE != null && !!fetchedAt && Date.parse(fetchedAt) >= SWEEP_SINCE;
}

function pickTrendToPublish(existingPoints, freshPoints, metricKey = null) {
  if (!existingPoints || existingPoints.length === 0) return freshPoints || [];
  // Retraction only on a TARGET_SYMBOL run that names this metric, same
  // narrow rule as generateForeignFilingsCache.js.
  const recomputing = !!metricKey && RECOMPUTE_METRICS.has(metricKey);
  // Retraction (a fresh empty result blanking a published series) is opt-in
  // on top of a targeted recompute: RECOMPUTE_ALLOW_RETRACT=1. A recompute
  // otherwise only adds points or replaces values -- never narrows a series.
  if (recomputing && process.env.TARGET_SYMBOL && process.env.RECOMPUTE_ALLOW_RETRACT === '1' && (!freshPoints || freshPoints.length === 0)) return [];
  if (!freshPoints || freshPoints.length === 0) return existingPoints;
  const merged = new Map();
  for (const p of existingPoints) merged.set(p.label, p);
  // Still a union when recomputing: fresh wins a label it recomputed, and
  // every published label it does not cover survives.
  // A recompute only ever REPLACES a published value with a real number.
  // A fresh null (or NaN) for a label that is already published is not
  // written -- a recompute must correct values, never blank them -- and
  // since this is a union, a label fresh does not cover is never dropped,
  // so a recompute can never leave a series narrower than it found it.
  for (const p of freshPoints) {
    if (!merged.has(p.label)) merged.set(p.label, p);
    else if (recomputing && Number.isFinite(p.value)) merged.set(p.label, p);
  }
  const sorted = [...merged.values()].sort((a, b) => {
    const oa = parseLabelToOrdinal(a.label);
    const ob = parseLabelToOrdinal(b.label);
    return oa != null && ob != null ? oa - ob : 0;
  });
  // Leading null points carry no data -- a null in the MIDDLE marks a real
  // gap and stays, but nulls before the first real value are placeholders.
  // Verified live: SE's TTM P/E opened with "Q1-Q4 '12" nulls, years before
  // the company existed, ahead of its real points.
  const firstReal = sorted.findIndex((p) => p.value != null);
  return (firstReal > 0 ? sorted.slice(firstReal) : sorted).slice(-QUARTERS_OF_HISTORY);
}

function pickCadenceTrendsToPublish(existingEntry, fresh, metricKey = null) {
  return {
    ttm: pickTrendToPublish(existingEntry?.ttm, fresh.ttm, metricKey),
    quarterly: pickTrendToPublish(existingEntry?.quarterly, fresh.quarterly, metricKey),
    yearly: pickTrendToPublish(existingEntry?.yearly, fresh.yearly, metricKey),
  };
}

async function main() {
  const twelveDataKey = readTwelveDataApiKey();

  console.log('Fetching known foreign-filer list, ticker universe + P/FCF gap list + SEC ticker->CIK map...');
  const [foreignFilerList, metricsDataset, tickerToCik, existingCache, existingPeCache] = await Promise.all([
    fetchSecJson(GIST_FOREIGN_FILER_LIST_URL).catch(() => null),
    fetchSecJson(GIST_METRICS_URL),
    fetchTickerToCikMap(),
    fetchSecJson(GIST_FOREIGN_PFCF_URL).catch(() => null),
    // pfcfTrendCache.json -- the DOMESTIC pipeline's own file, shared here
    // only for the `.pe` key of foreign tickers (see GIST_PFCF_TREND_URL's
    // own comment). Fetched fresh every run, same as the other 3 -- this
    // repo has zero write access advantage over stock-metrics-pipeline's
    // own runs, so this MUST be re-read at merge time, never cached
    // locally, to never clobber whatever the domestic pipeline (or an
    // interleaved run of this same script) published most recently for
    // domestic tickers or for a DIFFERENT foreign ticker's `.pe` entry.
    fetchSecJson(GIST_PFCF_TREND_URL).catch(() => null),
  ]);

  const cache = existingCache?.trends || {};
  const peCache = existingPeCache?.trends || {};

  // The isGenuineForeignFiler check inside the loop below (before any
  // Twelve Data spend) is what actually filters out non-foreign tickers —
  // cheap since it happens on the SEC fetch alone, before any Twelve Data
  // budget is touched. Still kept as a real gate even on the fast path
  // below (not just trusting the list blindly), same defense-in-depth
  // generateForeignFilingsCache.js's own processTicker applies.
  let withCik;
  if (foreignFilerList?.foreignFilers?.length) {
    withCik = foreignFilerList.foreignFilers;
    console.log(`Using the published foreign-filer list (generated ${foreignFilerList.generatedAt}): ${withCik.length} known foreign filers.`);
  } else {
    // Graceful bootstrap fallback — same reasoning as
    // generateForeignFilingsCache.js's identical fallback: slower, but
    // never wrong, and only hit if the discovery job's list is unavailable.
    console.log('No foreign-filer list available yet — falling back to a full-universe classification scan for this run.');
    const candidates = Object.entries(metricsDataset.metrics || {}).map(([symbol]) => symbol);
    withCik = candidates.map((symbol) => ({ symbol, cik: tickerToCik.get(symbol) })).filter((c) => c.cik);
    console.log(`${candidates.length} tickers in the covered universe; ${withCik.length} of those have a matching SEC CIK.`);
  }

  // Least-recently-attempted first (never-attempted sorts first, via epoch
  // 0) -- same rotation strategy as stock-metrics-pipeline's own
  // generatePfcfTrendCache.js. Necessary now that the universe (769 known
  // foreign filers, up from ~133 when this script was first written) no
  // longer reliably fits in one run -- verified live: this job previously
  // hit its own 60-minute workflow timeout partway through the full list,
  // and since nothing here persisted per-ticker progress, tickers landing
  // later in iteration order (e.g. DHT) never got reached at all, no
  // matter how many times the workflow ran on schedule.
  let priority = withCik
    .map((entry) => ({ ...entry, attemptedAt: cache[entry.symbol]?.fetchedAt ? new Date(cache[entry.symbol].fetchedAt).getTime() : 0 }))
    .sort((a, b) => a.attemptedAt - b.attemptedAt);

  // Manual single/multi-symbol override, same TARGET_SYMBOL pattern used
  // throughout this repo's sibling scripts -- bypasses the gap
  // list/rotation entirely for fast, isolated debugging of specific
  // tickers (comma-separated, matching generateForeignFilingsCache.js's
  // own multi-symbol support).
  if (process.env.TARGET_SYMBOL) {
    const targets = process.env.TARGET_SYMBOL.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
    priority = targets.map((target) => ({ symbol: target, cik: tickerToCik.get(target) })).filter((c) => c.cik);
    console.log(`TARGET_SYMBOL set — processing only ${priority.map((c) => c.symbol).join(', ') || '(none found in universe)'}, ignoring the normal gap list/rotation.`);
  }

  const startTime = Date.now();
  let processed = 0;
  let resolved = 0;
  let twelveDataCalls = 0;

  for (const { symbol, cik } of priority) {
    if (twelveDataCalls >= MAX_TWELVEDATA_CALLS_PER_RUN) {
      console.log(`Twelve Data call budget (${MAX_TWELVEDATA_CALLS_PER_RUN}) reached after ${processed} tickers — stopping for this run.`);
      break;
    }
    if (Date.now() - startTime > TIME_BUDGET_MS) {
      console.log(`Time budget reached after ${processed} tickers — stopping for this run.`);
      break;
    }
    let fresh = { ttm: [], quarterly: [], yearly: [] };
    let freshPe = { ttm: [], quarterly: [], yearly: [] };
    let computed = false;
    try {
      const companyFacts = await fetchSecJson(`${SEC_COMPANYFACTS_BASE}/CIK${cik}.json`);
      await sleep(SEC_REQUEST_SPACING_MS);

      // Only genuine foreign filers (ifrs-full, OR us-gaap with real
      // 20-F/40-F/6-K form history -- see isGenuineForeignFiler's own
      // comment) — a domestic filer's SEC companyfacts also has real
      // us-gaap data, so without this gate extractFactSeries's us-gaap
      // fallback would happily compute P/FCF for every SEC-registered
      // company, duplicating stock-metrics-pipeline's own Finnhub-based
      // reconstruction. Checked BEFORE any Twelve Data call, so scanning
      // the ~5,000 non-foreign tickers in the full candidate list above
      // costs nothing but SEC requests. Previously checked ifrs-full
      // alone, silently excluding 395 of 769 known foreign filers (51%,
      // every us-gaap-taxonomy one) regardless of anything else in this
      // file -- verified live for ASC specifically.
      const isForeignFiler = isGenuineForeignFiler(companyFacts);

      if (isForeignFiler) {
        const reportingCurrency = detectReportingCurrency(companyFacts);
        const ocfRaw = extractFactSeries(companyFacts, OCF_CONCEPTS, reportingCurrency);
        const capexRaw = extractFactSeries(companyFacts, CAPEX_CONCEPTS, reportingCurrency);
        const sharesRaw = extractFactSeries(companyFacts, SHARES_CONCEPTS);
        // For P/E -- same raw-XBRL-first, 20-F-recovery, 6-K-text-extraction
        // fallback chain as capex/ocf/shares below, just for net income.
        const netIncomeRaw = extractFactSeries(companyFacts, NET_INCOME_CONCEPTS, reportingCurrency);
        let ocf = dedupeAndClassify(ocfRaw);
        let capex = dedupeAndClassify(capexRaw);
        // Every share series below goes through splitAdjust -- see
        // detectSplitEvents.
        const yahooSplits = await fetchYahooSplits(symbol);
        const splitEvents = detectSplitEvents(sharesRaw, companyFacts?.facts?.dei?.EntityCommonStockSharesOutstanding?.units?.shares || [], yahooSplits);
        const latestSharesFiled = sharesRaw.reduce((m, f) => (f.filed && f.filed > m ? f.filed : m), '');
        for (const y of yahooSplits) {
          // Dated exactly, so anything filed before it is on the old basis.
          const dayBefore = new Date(Date.parse(y.date) - 86400000).toISOString().slice(0, 10);
          if (latestSharesFiled && y.date > latestSharesFiled) splitEvents.push({ after: dayBefore, by: y.date, factor: y.factor });
        }
        if (splitEvents.length) {
          console.log(`  ${symbol}: share splits ${splitEvents.map((e) => `x${+e.factor.toPrecision(4)} between ${e.after} and ${e.by}`).join('; ')}`);
        }
        const classifyShares = (facts) => {
          const classified = dedupeAndClassify(splitAdjust(facts, splitEvents), 'shares');
          return { quarterly: dropShareOutliers(classified.quarterly), annual: dropShareOutliers(classified.annual) };
        };
        let shares = classifyShares(sharesRaw);
        let netIncome = dedupeAndClassify(netIncomeRaw);

        // Per-ticker, per-concept -- see computeCumulativeFallbackConcepts'
        // own comment in extractFilingTextFacts.js for why this can't be a
        // static list.
        const cumulativeFallbackConcepts = computeCumulativeFallbackConcepts({ ocf: ocfRaw, capex: capexRaw, shares: sharesRaw, netIncome: netIncomeRaw });

        // Capex is the concept that's actually gapped for this universe --
        // verified live: ASC has zero capex XBRL facts under ANY of
        // CAPEX_CONCEPTS (its "Purchase of vessels" line isn't tagged with
        // a concept this list recognizes), and DHT's capex XBRL stops being
        // tagged at all after FY2021 even though its ocf/shares XBRL stay
        // current through today -- while its ocf/shares are fine. Reuses
        // the SAME 6-K earnings-release text-extraction fallback already
        // shipped and verified in generateForeignFilingsCache.js's own
        // processTicker for exactly these tickers, rather than duplicating
        // that ~1000-line extractor. Only attempted when capex specifically
        // needs it (needsFilingTextBackfill), not gated behind
        // ENABLE_FILING_TEXT_FALLBACK the way the sibling script's daily
        // run still is -- that flag exists there because EVERY concept gets
        // scanned for EVERY gap ticker (a multi-hour cost even with a
        // 350-minute timeout); here it's one targeted concept, checked only
        // for tickers this loop already reached under its own rotation
        // budget.
        // 20-F annual fallback -- fills a gap the 6-K quarterly pass below
        // can't: a filer whose 20-F switched capex to a company-specific
        // custom XBRL extension tag (verified live: DHT's
        // `dht:InvestmentsInVessels`), never exposed under any standard
        // taxonomy name in companyfacts no matter how many concept-list
        // alternatives are added -- only parsing the 20-F document itself
        // recovers it. Not gated behind ENABLE_20F_ANNUAL_FALLBACK the way
        // the sibling script's daily run is -- same reasoning as the 6-K
        // call below: one targeted concept, only for tickers this loop
        // already reached under its own rotation budget, not a
        // full-universe scan.
        //
        // Deliberately run BEFORE the 6-K quarterly pass below (this used
        // to run after, "so a ticker the 6-K pass already fixed doesn't
        // pay for the heavier 20-F scan" -- a real cost optimization, but
        // verified live it caused a genuine correctness bug for DHT:
        // extractQuarterlyFactsFromFilings's own scale-detection
        // (detectScaleMultiplier) uses whatever annual figure is passed as
        // its verification anchor to decide whether the 6-K table's raw
        // "$ in thousands" values need multiplying by 1000. Anchored on
        // capex.annual BEFORE this 20-F recovery, that anchor was DHT's
        // stale, tiny (~$48K/year) native-XBRL figure -- coincidentally
        // close enough in magnitude to the un-scaled thousands-figure that
        // the detector concluded no correction was needed, silently
        // publishing quarterly capex 1000x too small (and, joined against
        // OCF at its correct real scale, a wildly wrong P/FCF ratio). With
        // the real ~$50-300M/year 20-F-recovered figure available first,
        // the SAME detector correctly identifies and applies the 1000x
        // correction.
        let annual20FCapexFacts = [];
        if (needsAnnual20FBackfill(capex.annual)) {
          try {
            const annualByEnd = { capex: new Map(capex.annual.map((a) => [a.end, a])) };
            const annual20FFacts = await extractAnnualFactsFrom20F(cik, ['capex'], annualByEnd, SEC_USER_AGENT);
            if (annual20FFacts.capex?.length) {
              annual20FCapexFacts = annual20FFacts.capex.map((f) => ({ ...f, val: -f.val }));
              capex = dedupeAndClassify([...capexRaw, ...annual20FCapexFacts]);
            }
          } catch (err) {
            console.log(`  20-F capex fallback failed for ${symbol}: ${err.message}`);
          }
        }

        // 20-F recovery for ocf/shares -- same pattern as capex above.
        // Added for STNG specifically: it has zero raw XBRL for ocf/capex/
        // shares quarterly, so capex's fallback alone still leaves the
        // ocf/shares side of the join empty.
        let annual20FOcfFacts = [];
        if (needsAnnual20FBackfill(ocf.annual)) {
          try {
            const annualByEnd = { ocf: new Map(ocf.annual.map((a) => [a.end, a])) };
            const annual20FFacts = await extractAnnualFactsFrom20F(cik, ['ocf'], annualByEnd, SEC_USER_AGENT);
            if (annual20FFacts.ocf?.length) {
              annual20FOcfFacts = annual20FFacts.ocf;
              ocf = dedupeAndClassify([...ocfRaw, ...annual20FOcfFacts]);
            }
          } catch (err) {
            console.log(`  20-F ocf fallback failed for ${symbol}: ${err.message}`);
          }
        }
        let annual20FSharesFacts = [];
        if (needsAnnual20FBackfill(shares.annual)) {
          try {
            const annualByEnd = { shares: new Map(shares.annual.map((a) => [a.end, a])) };
            const annual20FFacts = await extractAnnualFactsFrom20F(cik, ['shares'], annualByEnd, SEC_USER_AGENT);
            if (annual20FFacts.shares?.length) {
              annual20FSharesFacts = annual20FFacts.shares;
              shares = classifyShares([...sharesRaw, ...annual20FSharesFacts]);
            }
          } catch (err) {
            console.log(`  20-F shares fallback failed for ${symbol}: ${err.message}`);
          }
        }
        // Same 20-F recovery, for net income -- same reasoning as ocf/shares
        // above (a filer with zero raw XBRL net income quarterly needs this
        // to have anything to derive quarters from at all).
        let annual20FNetIncomeFacts = [];
        if (needsAnnual20FBackfill(netIncome.annual)) {
          try {
            const annualByEnd = { netIncome: new Map(netIncome.annual.map((a) => [a.end, a])) };
            const annual20FFacts = await extractAnnualFactsFrom20F(cik, ['netIncome'], annualByEnd, SEC_USER_AGENT);
            if (annual20FFacts.netIncome?.length) {
              annual20FNetIncomeFacts = annual20FFacts.netIncome;
              netIncome = dedupeAndClassify([...netIncomeRaw, ...annual20FNetIncomeFacts]);
            }
          } catch (err) {
            console.log(`  20-F netIncome fallback failed for ${symbol}: ${err.message}`);
          }
        }

        // 6-K quarterly text-extraction for whichever of capex/ocf/shares
        // still needs it, requested TOGETHER in one call rather than three
        // separate ones -- verified live this matters, not just a tidiness
        // preference: extractQuarterlyFactsFromFilings's scale-detection
        // (detectScaleMultiplier) is scored per CALL, across every concept
        // passed to it together, specifically so a concept with a reliable
        // annual anchor (usually capex here, via the 20-F recovery above)
        // can "carry along" a correct scale for a concept that has none of
        // its own to verify against. STNG has zero real annual OCF data
        // anywhere (native XBRL or 20-F) -- requested alone, OCF's own
        // scale-detection had nothing to score at all and silently
        // defaulted to no correction, publishing OCF three orders of
        // magnitude too small (and a P/FCF ratio in the thousands once
        // joined against a correctly-scaled share count). Requested
        // alongside capex (which DOES have a real, large-scale 20-F
        // anchor for STNG), the same real "$ in thousands" table this OCF
        // figure comes from gets correctly identified and scaled.
        const trulyNeededQuarterlyConcepts = [];
        if (needsFilingTextBackfill(capex.quarterly, capex.annual)) trulyNeededQuarterlyConcepts.push('capex');
        if (needsFilingTextBackfill(ocf.quarterly, ocf.annual)) trulyNeededQuarterlyConcepts.push('ocf');
        if (needsFilingTextBackfill(shares.quarterly, shares.annual)) trulyNeededQuarterlyConcepts.push('shares');
        if (needsFilingTextBackfill(netIncome.quarterly, netIncome.annual)) trulyNeededQuarterlyConcepts.push('netIncome');
        // Once the call is worth making at all, request ALL FOUR
        // concepts together, not just whichever genuinely still needs new
        // data -- verified live this matters even after combining the
        // calls above: STNG's capex.quarterly already has real native XBRL
        // (so capex alone never triggered needsFilingTextBackfill, never
        // making it into the combined call), leaving OCF's scale-detection
        // just as anchor-less as when it was requested completely alone.
        // A concept that doesn't strictly need new text-extracted data
        // still benefits scale-detection by being IN this same call -- its
        // own real annual anchor only gets scored against extracted
        // candidates when this scan actually goes looking for that concept
        // too. Extra parsing cost only for tickers already reached by this
        // script's own rotation, not a full-universe cost. netIncome added
        // alongside the original three for the same reason -- it's a
        // distinct income-statement concept, but one more concept scored
        // in the SAME call only strengthens (never weakens)
        // detectScaleMultiplier's shared verdict for this filer.
        const neededQuarterlyConcepts = trulyNeededQuarterlyConcepts.length ? ['capex', 'ocf', 'shares', 'netIncome'] : [];

        let capexFilingTextFacts = {};
        let ocfFilingTextFacts = {};
        let sharesFilingTextFacts = {};
        let netIncomeFilingTextFacts = {};
        if (neededQuarterlyConcepts.length) {
          try {
            const annualByEnd = {
              capex: new Map(capex.annual.map((a) => [a.end, a])),
              ocf: new Map(ocf.annual.map((a) => [a.end, a])),
              shares: new Map(shares.annual.map((a) => [a.end, a])),
              netIncome: new Map(netIncome.annual.map((a) => [a.end, a])),
            };
            const filingTextFacts = await extractQuarterlyFactsFromFilings(cik, neededQuarterlyConcepts, annualByEnd, SEC_USER_AGENT, cumulativeFallbackConcepts, symbol, {
              skipNativeConversion: reportingCurrency !== 'USD',
            });
            capexFilingTextFacts = { capex: filingTextFacts.capex };
            ocfFilingTextFacts = { ocf: filingTextFacts.ocf };
            sharesFilingTextFacts = { shares: filingTextFacts.shares };
            netIncomeFilingTextFacts = { netIncome: filingTextFacts.netIncome };
            // XBRL's capex concept is a positive magnitude but the
            // press-release table reports it parenthesized/negative (a
            // cash outflow) -- negated here to match XBRL's sign
            // convention, same as generateForeignFilingsCache.js's own
            // identical merge. OCF's, shares', and net income's text-
            // extracted sign conventions already match XBRL's directly, no
            // flip needed.
            if (capexFilingTextFacts.capex?.length) {
              capex = dedupeAndClassify([...capexRaw, ...annual20FCapexFacts, ...capexFilingTextFacts.capex.map((f) => ({ ...f, val: -f.val }))]);
            }
            if (ocfFilingTextFacts.ocf?.length) {
              ocf = dedupeAndClassify([...ocfRaw, ...annual20FOcfFacts, ...ocfFilingTextFacts.ocf]);
            }
            if (sharesFilingTextFacts.shares?.length) {
              shares = classifyShares([...sharesRaw, ...annual20FSharesFacts, ...sharesFilingTextFacts.shares]);
            }
            if (netIncomeFilingTextFacts.netIncome?.length) {
              netIncome = dedupeAndClassify([...netIncomeRaw, ...annual20FNetIncomeFacts, ...netIncomeFilingTextFacts.netIncome]);
            }
          } catch (err) {
            console.log(`  filing-text fallback failed for ${symbol}: ${err.message}`);
          }
        }

        // Last-resort BusinessQuant fallback for shares specifically --
        // added for IMPP, which only ever discloses shares at H1/FY
        // cadence (never a standalone quarter anywhere, so the two
        // fallbacks above have nothing to decumulate against). Verified
        // live: BusinessQuant's own quarterly shares-outstanding series
        // matches IMPP's real filed weighted-average-shares to the exact
        // share at every date IMPP itself discloses (both H1 and FY,
        // basic and diluted) -- see verifyByGroundTruthMatch's own comment
        // in businessQuantFallback.js for why this needs a different
        // verification than the sum-to-annual Check B used for the other
        // concepts (a share count isn't additive across quarters). Ground
        // truth here is EVERY real disclosed value regardless of duration
        // (not just shares.annual, which drops IMPP's real H1 facts --
        // dedupeAndClassify only classifies genuine ~90-day or ~365-day
        // spans), most-recently-filed wins per end-date, same tiebreak
        // dedupeAndClassify itself already uses elsewhere.
        if (needsFilingTextBackfill(shares.quarterly, shares.annual) && process.env.ENABLE_BUSINESSQUANT_FALLBACK && process.env.BUSINESSQUANT_API_KEY) {
          try {
            const groundTruth = new Map();
            for (const f of sharesRaw) {
              const existing = groundTruth.get(f.end);
              if (!existing || new Date(f.filed) > new Date(existing.filed)) {
                groundTruth.set(f.end, { end: f.end, value: f.val, filed: f.filed });
              }
            }
            const bqFacts = await fetchBusinessQuantFacts(symbol, ['shares'], { shares: groundTruth }, process.env.BUSINESSQUANT_API_KEY);
            if (bqFacts.shares?.length) shares = classifyShares([...sharesRaw, ...bqFacts.shares]);
          } catch (err) {
            console.log(`  BusinessQuant shares fallback failed for ${symbol}: ${err.message}`);
          }
        }

        // Prices are USD; bring every monetary series to USD to match. The
        // 20-F and 6-K text paths both keep the filer's own column and drop
        // a USD convenience one, so their facts are in reportingCurrency too.
        // Shares per US-listed share -- see fetchAdsRatio. An unreadable
        // ratio leaves no share count, so nothing per-share is published.
        const adsRatio = await fetchAdsRatio(cik);
        await sleep(SEC_REQUEST_SPACING_MS);
        if (adsRatio !== 1) {
          const perAds = (points) => (adsRatio ? points.map((p) => ({ ...p, value: p.value / adsRatio })) : []);
          shares = { quarterly: perAds(shares.quarterly), annual: perAds(shares.annual) };
          console.log(`  ${symbol}: ${adsRatio ? `each ADS = ${adsRatio} shares` : 'ADS ratio ambiguous, no per-share figures'}`);
        }
        if (reportingCurrency !== 'USD') {
          ocf = await convertSeriesToUsd(ocf, reportingCurrency);
          capex = await convertSeriesToUsd(capex, reportingCurrency);
          netIncome = await convertSeriesToUsd(netIncome, reportingCurrency);
          console.log(`  ${symbol}: reports in ${reportingCurrency}, converted to USD`);
        }

        const monthlyPrices = await fetchMonthlyPrices(symbol, twelveDataKey);
        await sleep(TWELVEDATA_REQUEST_SPACING_MS);
        twelveDataCalls++;

        if (process.env.DEBUG_FILING_EXTRACT) {
          console.error('DEBUG pfcf-inputs', symbol, 'ocf.quarterly', JSON.stringify(ocf.quarterly));
          console.error('DEBUG pfcf-inputs', symbol, 'capex.quarterly', JSON.stringify(capex.quarterly));
          console.error('DEBUG pfcf-inputs', symbol, 'shares.quarterly', JSON.stringify(shares.quarterly));
          console.error('DEBUG pfcf-inputs', symbol, 'netIncome.quarterly', JSON.stringify(netIncome.quarterly));
          console.error('DEBUG pfcf-inputs', symbol, 'monthlyPrices', JSON.stringify(monthlyPrices.slice(0, 5)), '...', monthlyPrices.length, 'total');
        }

        // All three cadences reuse this SAME fetched data — no extra API
        // calls beyond the ones already made above.
        fresh = {
          ttm: buildForeignPfcfTTM(ocf.quarterly, capex.quarterly, shares.quarterly, monthlyPrices),
          quarterly: buildForeignPfcfQuarterly(ocf.quarterly, capex.quarterly, shares.quarterly, monthlyPrices),
          yearly: buildForeignPfcfYearly(ocf.annual, capex.annual, shares.annual, monthlyPrices),
        };
        // P/E -- same fetched netIncome/shares/prices, zero extra API cost.
        freshPe = {
          ttm: buildForeignPeTTM(netIncome.quarterly, shares.quarterly, monthlyPrices),
          quarterly: buildForeignPeQuarterly(netIncome.quarterly, shares.quarterly, monthlyPrices),
          yearly: buildForeignPeYearly(netIncome.annual, shares.annual, monthlyPrices),
        };
        computed = true;
      }
    } catch (err) {
      console.log(`  skip ${symbol}: ${err.message}`);
      // pickCadenceTrendsToPublish below falls back to whatever was already
      // cached for this symbol rather than losing it over one failed request.
    }

    // Only a computation that actually ran may recompute -- a skipped or
    // failed ticker leaves fresh empty, which a recompute reads as retract.
    // During a scheduled sweep, also only a ticker not yet refreshed since
    // the sweep began, so each is recomputed exactly once. The rotation is
    // already stalest-first across every foreign filer, so it reaches all
    // of them without reordering.
    const mayRecompute = computed && !alreadySwept(cache[symbol]?.fetchedAt);
    const cadences = pickCadenceTrendsToPublish(cache[symbol], fresh, mayRecompute ? 'pfcfRatio' : null);
    cache[symbol] = { fetchedAt: new Date().toISOString(), ...cadences };
    if (cadences.ttm.length || cadences.quarterly.length || cadences.yearly.length) {
      resolved++;
    }

    // P/E -- merged separately into peCache (pfcfTrendCache.json), touching
    // ONLY this symbol's `.pe` key. peCache[symbol] may already exist here
    // (the domestic pipeline's own attempt at this same foreign ticker,
    // almost always empty since Finnhub's financials-reported rarely has
    // anything useful for a foreign filer -- see the CIK-mismatch class of
    // bug documented elsewhere for why that's sometimes actively WRONG
    // instead of just empty) -- spreading it first preserves that entry's
    // OWN top-level ttm/quarterly/yearly (P/FCF) fields untouched; this
    // script is never the source of truth for those (foreignPfcfCache.json
    // is, via its own separate app-side fetch chain).
    const peCadences = pickCadenceTrendsToPublish(peCache[symbol]?.pe, freshPe, mayRecompute ? 'peRatio' : null);
    if (peCadences.ttm.length || peCadences.quarterly.length || peCadences.yearly.length) {
      peCache[symbol] = { ...peCache[symbol], fetchedAt: new Date().toISOString(), pe: peCadences };
    }

    processed++;
    if (processed % 25 === 0) {
      console.log(`  ${processed}/${withCik.length} processed (${resolved} resolved so far), ${twelveDataCalls} Twelve Data calls used`);
    }
  }

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify({ generatedAt: new Date().toISOString(), trends: cache }));
  fs.writeFileSync(OUTPUT_PE_FILE, JSON.stringify({ generatedAt: new Date().toISOString(), trends: peCache }));
  console.log(
    `Done. Processed ${processed} tickers (${resolved} resolved to at least one P/FCF trend, ${twelveDataCalls} Twelve Data calls used). ` +
      `Cache now covers ${Object.keys(cache).length} tickers total (P/E cache covers ${Object.keys(peCache).length} tickers total, shared with the domestic pipeline).`
  );
}

module.exports = {
  fetchAdsRatio,
  detectSplitEvents,
  splitAdjust,
  fetchYahooSplits,
  extractFactSeries,
  dedupeAndClassify,
  buildTrailingWindows,
  isAdjacent,
  quarterLabelFromDate,
  annualLabelFromDate,
  findClosestMonthlyPrice,
  buildForeignPfcfTTM,
  buildForeignPfcfQuarterly,
  buildForeignPfcfYearly,
  buildForeignPeTTM,
  buildForeignPeQuarterly,
  buildForeignPeYearly,
  isOcfScalePlausible,
  pickTrendToPublish,
  pickCadenceTrendsToPublish,
};

if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
