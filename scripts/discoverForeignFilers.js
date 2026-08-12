// scripts/discoverForeignFilers.js
//
// Periodic (weekly), CHEAP classification-only pass across the full ticker
// universe: for each ticker, checks ONLY whether it's a genuine IFRS foreign
// filer (companyFacts.facts['ifrs-full'] present) - no concept extraction,
// no 6-K filing-text fallback, none of generateForeignFilingsCache.js's
// expensive per-ticker work. Publishes the resulting {symbol, cik, industry}
// list as foreignFilerList.json, which the DAILY generateForeignFilingsCache.js
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

// The ONLY real check this script does per ticker - deliberately identical
// to processTicker's own ifrs-full gate in generateForeignFilingsCache.js
// (kept in sync), just without any of the concept extraction that follows
// it there.
async function isGenuineIfrsFiler(cik) {
  const companyFacts = await fetchJson(`${SEC_COMPANYFACTS_BASE}/CIK${cik}.json`);
  return !!(companyFacts?.facts?.['ifrs-full'] && Object.keys(companyFacts.facts['ifrs-full']).length);
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
      if (await isGenuineIfrsFiler(cik)) foreignFilers.push({ symbol, cik, industry });
    } catch (err) {
      console.log(`  skip ${symbol}: ${err.message}`);
    }
    await sleep(REQUEST_SPACING_MS);

    processed++;
    if (processed % 250 === 0) console.log(`  ${processed}/${withCik.length} processed (${foreignFilers.length} confirmed foreign filers so far)`);
  }

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify({ generatedAt: new Date().toISOString(), foreignFilers }));
  console.log(`Done. Processed ${processed} tickers, ${foreignFilers.length} confirmed as genuine IFRS foreign filers.`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
