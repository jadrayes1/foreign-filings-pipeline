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
const GIST_METRICS_URL = 'https://gist.githubusercontent.com/jadrayes1/db6fbd96e980118d3c6a63965dc0dc39/raw/marketMetrics.json';
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
  const [metricsDataset, tickerToCik] = await Promise.all([fetchJson(GIST_METRICS_URL), fetchTickerToCikMap()]);

  const candidates = Object.entries(metricsDataset.metrics || {}).map(([symbol, data]) => ({ symbol, industry: data.industry }));
  const withCik = candidates.map((c) => ({ ...c, cik: tickerToCik.get(c.symbol) })).filter((c) => c.cik);
  console.log(`${candidates.length} tickers in the covered universe; ${withCik.length} of those have a matching SEC CIK. Checking each for real IFRS data...`);

  const foreignFilers = [];
  let processed = 0;
  for (const { symbol, cik, industry } of withCik) {
    try {
      const taxonomy = await detectForeignFilerTaxonomy(cik);
      if (taxonomy) foreignFilers.push({ symbol, cik, industry, taxonomy });
    } catch (err) {
      console.log(`  skip ${symbol}: ${err.message}`);
    }
    await sleep(REQUEST_SPACING_MS);

    processed++;
    if (processed % 250 === 0) console.log(`  ${processed}/${withCik.length} processed (${foreignFilers.length} confirmed foreign filers so far)`);
  }

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify({ generatedAt: new Date().toISOString(), foreignFilers }));
  const gaapCount = foreignFilers.filter((f) => f.taxonomy === 'us-gaap').length;
  console.log(`Done. Processed ${processed} tickers, ${foreignFilers.length} confirmed foreign filers (${foreignFilers.length - gaapCount} ifrs-full, ${gaapCount} us-gaap).`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
