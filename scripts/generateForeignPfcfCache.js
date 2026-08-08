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
// Unlike stock-metrics-pipeline's P/FCF job, this doesn't need a
// least-recently-attempted rotation — the foreign-filer universe (~133
// tickers as of this writing) is small enough that a full pass fits
// comfortably in one run well under Twelve Data's daily cap (~133 calls vs.
// an 800/day budget).

const fs = require('fs');
const path = require('path');

const OUTPUT_FILE = path.join(__dirname, '../foreignPfcfCache.json');
const GIST_METRICS_URL = 'https://gist.githubusercontent.com/jadrayes1/db6fbd96e980118d3c6a63965dc0dc39/raw/marketMetrics.json';
const GIST_FOREIGN_PFCF_URL = 'https://gist.githubusercontent.com/jadrayes1/db6fbd96e980118d3c6a63965dc0dc39/raw/foreignPfcfCache.json';
const SEC_TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';
const SEC_COMPANYFACTS_BASE = 'https://data.sec.gov/api/xbrl/companyfacts';
// SEC's fair-use policy asks for a descriptive User-Agent identifying the
// requester and a real contact — this is NOT an API key, just good-citizen
// identification; see https://www.sec.gov/os/webmaster-faq#developers
const SEC_USER_AGENT = 'stock-analyzer-app foreign-filings-pipeline contact:jadrayescpp@gmail.com';
const SEC_REQUEST_SPACING_MS = 200; // well under SEC's documented ~10 req/sec fair-use guidance
const TWELVEDATA_REQUEST_SPACING_MS = 8000; // ~7.5/min, under Twelve Data's free-tier 8/min cap
const QUARTERS_OF_HISTORY = 12; // mirrors src/utils/metrics.js

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

async function fetchMonthlyPrices(symbol, apiKey) {
  const res = await fetch(`https://api.twelvedata.com/time_series?symbol=${symbol}&interval=1month&outputsize=48&apikey=${apiKey}`);
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

const OCF_CONCEPTS = ['CashFlowsFromUsedInOperatingActivities'];
const CAPEX_CONCEPTS = [
  'PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities',
  'PurchaseOfPropertyPlantAndEquipmentIntangibleAssetsOtherThanGoodwillInvestmentPropertyAndOtherNoncurrentAssets',
];
const SHARES_CONCEPTS = ['WeightedAverageShares'];

function extractFactSeries(companyFacts, conceptCandidates) {
  for (const taxonomy of ['ifrs-full', 'us-gaap']) {
    const facts = companyFacts?.facts?.[taxonomy];
    if (!facts) continue;
    for (const concept of conceptCandidates) {
      const entry = facts[concept];
      if (!entry?.units) continue;
      for (const unitFacts of Object.values(entry.units)) {
        if (Array.isArray(unitFacts) && unitFacts.length) return unitFacts;
      }
    }
  }
  return [];
}

function daysBetween(startStr, endStr) {
  const start = new Date(startStr);
  const end = new Date(endStr);
  return (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24);
}

function quarterLabelFromDate(dateStr) {
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return null;
  const q = Math.floor(d.getUTCMonth() / 3) + 1;
  return `Q${q} '${String(d.getUTCFullYear()).slice(-2)}`;
}

function annualLabelFromDate(dateStr) {
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return null;
  return `FY '${String(d.getUTCFullYear()).slice(-2)}`;
}

// Same dedupe-by-(start,end)-then-classify-by-duration logic as
// generateForeignFilingsCache.js's dedupeAndClassify — kept as its own copy
// (CommonJS, not part of the app's ES module bundle, same reasoning
// generateForeignFilingsCache.js's own header gives) rather than requiring
// across the two scripts.
function dedupeAndClassify(rawFacts) {
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

  const quarterly = [];
  const annual = [];
  for (const fact of byPeriod.values()) {
    const days = daysBetween(fact.start, fact.end);
    const point = { start: fact.start, end: fact.end, value: fact.val };
    if (days >= 80 && days <= 100) quarterly.push(point);
    else if (days >= 350 && days <= 380) annual.push(point);
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
    .filter((o) => capexByEnd.has(o.end) && sharesByEnd.get(o.end) > 0)
    .map((o) => ({ start: o.start, end: o.end, fcf: o.value - capexByEnd.get(o.end), shares: sharesByEnd.get(o.end) }));

  return buildTrailingWindows(standalone, 4)
    .map(({ quarters, anchor, partial }) => {
      const ttmFcf = quarters.reduce((sum, q) => sum + q.fcf, 0);
      const ttmFcfPerShare = ttmFcf / anchor.shares;
      const price = findClosestMonthlyPrice(monthlyPrices, anchor.end);
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
    .filter((o) => capexByEnd.has(o.end) && sharesByEnd.get(o.end) > 0)
    .map((o) => {
      const annualizedFcfPerShare = ((o.value - capexByEnd.get(o.end)) / sharesByEnd.get(o.end)) * 4;
      const price = findClosestMonthlyPrice(monthlyPrices, o.end);
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
  return ocfAnnual
    .filter((o) => capexByEnd.has(o.end) && sharesByEnd.get(o.end) > 0)
    .map((o) => {
      const fcfPerShare = (o.value - capexByEnd.get(o.end)) / sharesByEnd.get(o.end);
      const price = findClosestMonthlyPrice(monthlyPrices, o.end);
      const value = price != null && fcfPerShare !== 0 ? price / fcfPerShare : null;
      return value != null ? { label: annualLabelFromDate(o.end), value } : null;
    })
    .filter(Boolean)
    .slice(-QUARTERS_OF_HISTORY);
}

// A fresh attempt can come back empty or narrower on a day where SEC or
// Twelve Data has a transient hiccup for this specific filer — mirrors
// pickTrendToPublish/pickCadenceTrendsToPublish in
// generatePfcfTrendCache.js and generateForeignFilingsCache.js.
function pickTrendToPublish(existingPoints, freshPoints) {
  if (!freshPoints || freshPoints.length === 0) return existingPoints || [];
  if (!existingPoints || existingPoints.length === 0) return freshPoints;
  const existingLabels = new Set(existingPoints.map((p) => p.label));
  const hasNewQuarter = freshPoints.some((p) => !existingLabels.has(p.label));
  return hasNewQuarter ? freshPoints : existingPoints;
}

function pickCadenceTrendsToPublish(existingEntry, fresh) {
  return {
    ttm: pickTrendToPublish(existingEntry?.ttm, fresh.ttm),
    quarterly: pickTrendToPublish(existingEntry?.quarterly, fresh.quarterly),
    yearly: pickTrendToPublish(existingEntry?.yearly, fresh.yearly),
  };
}

async function main() {
  const twelveDataKey = readTwelveDataApiKey();

  console.log('Fetching ticker universe + P/FCF gap list + SEC ticker->CIK map...');
  const [metricsDataset, tickerToCik, existingCache] = await Promise.all([
    fetchSecJson(GIST_METRICS_URL),
    fetchTickerToCikMap(),
    fetchSecJson(GIST_FOREIGN_PFCF_URL).catch(() => null),
  ]);

  const cache = existingCache?.trends || {};

  // The FULL covered universe, not just tickers with a null pfcfRatio card
  // value — that's the wrong signal. A genuine IFRS filer's Finnhub NATIVE
  // pfcfTTM series can be fully populated (verified live: Scorpio Tankers/
  // STNG, Bank of Montreal/BMO both have real native pfcfRatio despite
  // being IFRS filers with zero Quarterly/Yearly reconstruction available
  // from anywhere) — a null card value only catches the subset with NO
  // native coverage at all, missing every filer whose current-value ratio
  // happens to be fine while its cadence-tab history isn't. The ifrs-full
  // check below (before any Twelve Data spend) is what actually filters
  // out the ~5,000 domestic tickers — cheap since it happens on the SEC
  // fetch alone, before any Twelve Data budget is touched.
  const candidates = Object.entries(metricsDataset.metrics || {}).map(([symbol]) => symbol);
  const withCik = candidates.map((symbol) => ({ symbol, cik: tickerToCik.get(symbol) })).filter((c) => c.cik);
  console.log(
    `${candidates.length} tickers in the covered universe; ${withCik.length} of those have a matching SEC CIK ` +
      `(the rest are either genuinely too new, or not SEC-registered at all). Each is checked for real IFRS data ` +
      `before spending any Twelve Data budget — most will resolve quickly to "not a foreign filer, skip."`
  );

  let processed = 0;
  let resolved = 0;
  let twelveDataCalls = 0;

  for (const { symbol, cik } of withCik) {
    let fresh = { ttm: [], quarterly: [], yearly: [] };
    try {
      const companyFacts = await fetchSecJson(`${SEC_COMPANYFACTS_BASE}/CIK${cik}.json`);
      await sleep(SEC_REQUEST_SPACING_MS);

      // Only genuine IFRS filers — see generateForeignFilingsCache.js's
      // identical check for the full rationale (a domestic filer's SEC
      // companyfacts also has real us-gaap data, so without this gate
      // extractFactSeries's us-gaap fallback would happily compute P/FCF
      // for every SEC-registered company, duplicating stock-metrics-
      // pipeline's own Finnhub-based reconstruction). Checked BEFORE any
      // Twelve Data call, so scanning the ~5,000 non-IFRS tickers in the
      // full candidate list above costs nothing but SEC requests.
      const isIfrsFiler = !!(companyFacts?.facts?.['ifrs-full'] && Object.keys(companyFacts.facts['ifrs-full']).length);

      if (isIfrsFiler) {
        const ocfRaw = extractFactSeries(companyFacts, OCF_CONCEPTS);
        const capexRaw = extractFactSeries(companyFacts, CAPEX_CONCEPTS);
        const sharesRaw = extractFactSeries(companyFacts, SHARES_CONCEPTS);
        const ocf = dedupeAndClassify(ocfRaw);
        const capex = dedupeAndClassify(capexRaw);
        const shares = dedupeAndClassify(sharesRaw);

        const monthlyPrices = await fetchMonthlyPrices(symbol, twelveDataKey);
        await sleep(TWELVEDATA_REQUEST_SPACING_MS);
        twelveDataCalls++;

        // All three cadences reuse this SAME fetched data — no extra API
        // calls beyond the ones already made above.
        fresh = {
          ttm: buildForeignPfcfTTM(ocf.quarterly, capex.quarterly, shares.quarterly, monthlyPrices),
          quarterly: buildForeignPfcfQuarterly(ocf.quarterly, capex.quarterly, shares.quarterly, monthlyPrices),
          yearly: buildForeignPfcfYearly(ocf.annual, capex.annual, shares.annual, monthlyPrices),
        };
      }
    } catch (err) {
      console.log(`  skip ${symbol}: ${err.message}`);
      // pickCadenceTrendsToPublish below falls back to whatever was already
      // cached for this symbol rather than losing it over one failed request.
    }

    const cadences = pickCadenceTrendsToPublish(cache[symbol], fresh);
    if (cadences.ttm.length || cadences.quarterly.length || cadences.yearly.length) {
      cache[symbol] = cadences;
      resolved++;
    }

    processed++;
    if (processed % 25 === 0) {
      console.log(`  ${processed}/${withCik.length} processed (${resolved} resolved so far), ${twelveDataCalls} Twelve Data calls used`);
    }
  }

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify({ generatedAt: new Date().toISOString(), trends: cache }));
  console.log(
    `Done. Processed ${processed} tickers (${resolved} resolved to at least one P/FCF trend, ${twelveDataCalls} Twelve Data calls used). ` +
      `Cache now covers ${Object.keys(cache).length} tickers total.`
  );
}

module.exports = {
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
  pickTrendToPublish,
  pickCadenceTrendsToPublish,
};

if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
