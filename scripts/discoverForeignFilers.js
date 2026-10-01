// scripts/discoverForeignFilers.js
//
// Periodic (weekly), CHEAP classification-only pass across the full ticker
// universe: for each ticker, checks ONLY whether it's a genuine foreign
// filer -- either the original ifrs-full-taxonomy check, or (added later)
// a us-gaap-taxonomy filer that genuinely files 20-F/40-F/6-K and never
// 10-K/10-Q (see detectForeignFilerTaxonomy's own comment) -- no concept
// extraction, no 6-K filing-text fallback, none of
// generateForeignFilingsCache.js's expensive per-ticker work. Publishes
// the resulting {symbol, cik, industry, taxonomy} list as
// foreignFilerList.json, which the DAILY generateForeignFilingsCache.js
// run then reads directly instead of re-deriving the same list from a full
// classification scan every single day.
//
// Why this exists as a SEPARATE periodic job rather than folding into the
// daily run: verified live this session (run 31626078351) that a full-
// universe scan combined with the real per-ticker 6-K fallback work takes
// ~5 hours end to end - most of that time is the fallback itself for the
// ~130-250 tickers that need it, not the classification step, but a full
// re-classification of all ~5,070 tickers EVERY day was still real,
// avoidable overhead (~25-40 min) on top of that. Splitting the cheap
// "which tickers are foreign filers" question from the expensive "extract
// their data" question lets the daily job skip straight to extraction for
// a known list, while this job periodically re-verifies the full universe
// to catch new entrants (recent IPOs, ticker reclassifications) - the same
// authoritative-check principle the original full-scan design was built
// around (see generateForeignFilingsCache.js's own comment on why a cached/
// heuristic candidate list was rejected before), just run on a slower
// cadence instead of every day.
//
// Estimated runtime: ~5,070 tickers * ~200ms SEC request spacing (SEC's
// documented ~10 req/sec fair-use guidance) + real fetch latency ≈
// 25-40 minutes - comfortably within a much shorter timeout than the daily
// job needs, verified against the SAME per-ticker cost this repo already
// measured for the classification-only portion of a real run.

const fs = require('fs');
const path = require('path');

const OUTPUT_FILE = path.join(__dirname, '../foreignFilerList.json');
const GIST_METRICS_URL = 'https://gist.githubusercontent.com/jadrayes1/5cd7f459788725521246717b9e164a8e/raw/marketMetrics.json';
const GIST_FOREIGN_FILER_LIST_URL = 'https://gist.githubusercontent.com/jadrayes1/5cd7f459788725521246717b9e164a8e/raw/foreignFilerList.json';
const SEC_TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';
const SEC_COMPANYFACTS_BASE = 'https://data.sec.gov/api/xbrl/companyfacts';
const SEC_USER_AGENT = 'stock-analyzer-app foreign-filings-pipeline contact:jadrayescpp@gmail.com';
const REQUEST_SPACING_MS = 200; // well under SEC's documented ~10 req/sec fair-use guidance
const FETCH_TIMEOUT_MS = 30000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, { headers: { 'User-Agent': SEC_USER_AGENT, Accept: 'application/json' }, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }
  return res.json();
}

async function fetchTickerToCikMap() {
  const data = await fetchJson(SEC_TICKERS_URL);
  const map = new Map();
  for (const entry of Object.values(data || {})) {
    if (entry?.ticker && entry?.cik_str != null) {
      map.set(String(entry.ticker).toUpperCase(), String(entry.cik_str).padStart(10, '0'));
    }
  }
  return map;
}

// A domestic US-GAAP filer's SEC companyfacts ALSO has real us-gaap data
// (every US public company files US-GAAP XBRL with SEC, foreign or not),
// so having us-gaap facts alone can't be the signal — the real signal is
// the FORM TYPES a filer actually submits: a genuine foreign private
// issuer files 20-F/40-F (annual) + 6-K (interim/current) and never
// 10-K/10-Q, regardless of which XBRL taxonomy it happens to tag under.
// Verified live: Ardmore Shipping/ASC, Teekay Tankers/TNK, and Imperial
// Petroleum/IMPP are all genuine 20-F/6-K filers using us-gaap (not
// ifrs-full) — the original ifrs-full-only check below missed this whole
// population. Scans the SAME companyFacts payload already fetched — no
// extra request needed.
const FOREIGN_ONLY_FORM_TYPES = new Set(['20-F', '20-F/A', '40-F', '40-F/A', '6-K', '6-K/A']);
const DOMESTIC_FORM_TYPES = new Set(['10-K', '10-K/A', '10-Q', '10-Q/A']);
function isGenuineForeignFormFiler(companyFacts) {
  let sawForeignForm = false;
  for (const taxonomyFacts of Object.values(companyFacts?.facts || {})) {
    for (const concept of Object.values(taxonomyFacts)) {
      for (const points of Object.values(concept.units || {})) {
        for (const p of points) {
          if (!p.form) continue;
          if (DOMESTIC_FORM_TYPES.has(p.form)) return false; // any real 10-K/10-Q disqualifies immediately
          if (FOREIGN_ONLY_FORM_TYPES.has(p.form)) sawForeignForm = true;
        }
      }
    }
  }
  return sawForeignForm;
}

// The ONLY real check this script does per ticker - deliberately identical
// to processTicker's own isGenuineForeignFiler gate in
// generateForeignFilingsCache.js (kept in sync), just without any of the
// concept extraction that follows it there. Returns the detected taxonomy
// (not just a boolean) so foreignFilerList.json can carry it through, even
// though nothing currently reads it back out — extractFactSeries already
// searches both taxonomies per concept regardless.
async function detectForeignFilerTaxonomy(cik) {
  const companyFacts = await fetchJson(`${SEC_COMPANYFACTS_BASE}/CIK${cik}.json`);
  if (companyFacts?.facts?.['ifrs-full'] && Object.keys(companyFacts.facts['ifrs-full']).length) return 'ifrs-full';
  if (companyFacts?.facts?.['us-gaap'] && Object.keys(companyFacts.facts['us-gaap']).length && isGenuineForeignFormFiler(companyFacts)) return 'us-gaap';
  return null;
}

async function main() {
  console.log('Fetching ticker universe from the published sector-metrics feed and SEC ticker->CIK map...');
  // previousList is fetched and MERGED into this run's result rather than
  // being replaced wholesale -- verified live 2026-10-01: SBS and CEPU, both
  // genuine ifrs-full foreign filers with rich real SEC data going back over
  // a decade, had silently vanished from a prior week's published list even
  // though generateForeignFilingsCache.js's own hard filter (`withCik =
  // foreignFilerList.foreignFilers`) means ANY ticker missing here is
  // permanently excluded from all foreign-filings processing, not just that
  // one week -- until pure chance re-includes it in some future run. The
  // candidate set below is built from a live snapshot of marketMetrics.json
  // (via `metricsDataset.metrics`), so a ticker that's merely absent or
  // mid-recovery in `staleSymbols` at the exact moment this weekly job
  // happens to run -- or a single transient SEC fetch failure for its CIK --
  // was enough to drop it from `candidates`/`withCik` and therefore from the
  // unconditional overwrite this used to do. Same "never silently regress"
  // principle already applied everywhere else in these pipelines via
  // pickTrendToPublish/pickMetricValue, just never applied to this list
  // before, even though it's the master gate the entire daily pipeline's
  // ticker universe depends on.
  const [metricsDataset, tickerToCik, previousList] = await Promise.all([
    fetchJson(GIST_METRICS_URL),
    fetchTickerToCikMap(),
    fetchJson(GIST_FOREIGN_FILER_LIST_URL).catch(() => null),
  ]);
  const previousBySymbol = new Map((previousList?.foreignFilers || []).map((f) => [f.symbol, f]));
  console.log(`Previous list (generated ${previousList?.generatedAt || 'unknown'}) had ${previousBySymbol.size} foreign filers.`);

  const candidates = Object.entries(metricsDataset.metrics || {}).map(([symbol, data]) => ({ symbol, industry: data.industry }));
  const withCik = candidates.map((c) => ({ ...c, cik: tickerToCik.get(c.symbol) })).filter((c) => c.cik);
  console.log(`${candidates.length} tickers in the covered universe; ${withCik.length} of those have a matching SEC CIK. Checking each for real IFRS data...`);

  // Only a ticker that was ACTUALLY checked this run and conclusively found
  // non-qualifying (detectForeignFilerTaxonomy returned null without
  // throwing -- i.e. real companyFacts were fetched and either show a
  // disqualifying 10-K/10-Q or no usable taxonomy at all) is treated as a
  // genuine disqualification. A ticker that threw (network blip, SEC rate
  // limit, timeout) or was never a candidate this run (absent from the
  // current marketMetrics.json snapshot) makes NO determination either way
  // -- its previous entry, if any, is carried forward unchanged below.
  const disqualifiedThisRun = new Set();
  const freshBySymbol = new Map();
  let processed = 0;
  for (const { symbol, cik, industry } of withCik) {
    try {
      const taxonomy = await detectForeignFilerTaxonomy(cik);
      if (taxonomy) {
        freshBySymbol.set(symbol, { symbol, cik, industry, taxonomy });
      } else {
        disqualifiedThisRun.add(symbol);
      }
    } catch (err) {
      console.log(`  skip ${symbol}: ${err.message}`);
    }
    await sleep(REQUEST_SPACING_MS);

    processed++;
    if (processed % 250 === 0) console.log(`  ${processed}/${withCik.length} processed (${freshBySymbol.size} confirmed foreign filers so far)`);
  }

  let carriedForward = 0;
  for (const [symbol, entry] of previousBySymbol) {
    if (!freshBySymbol.has(symbol) && !disqualifiedThisRun.has(symbol)) {
      freshBySymbol.set(symbol, entry);
      carriedForward++;
    }
  }
  const foreignFilers = [...freshBySymbol.values()];

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify({ generatedAt: new Date().toISOString(), foreignFilers }));
  const gaapCount = foreignFilers.filter((f) => f.taxonomy === 'us-gaap').length;
  console.log(`Done. Processed ${processed} tickers, ${foreignFilers.length} total foreign filers (${foreignFilers.length - gaapCount} ifrs-full, ${gaapCount} us-gaap), ${carriedForward} carried forward from the previous list (not reconfirmed this run, but not disqualified either), ${disqualifiedThisRun.size} explicitly disqualified this run.`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
