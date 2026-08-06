// scripts/generateForeignFilingsCache.js
//
// Reconstructs revenue-growth, profit-margin, and FCF-margin trends for
// FOREIGN-FILER tickers (Canadian banks/miners, UK pharma, etc.) that have
// no data at all from stock-analyzer's existing Finnhub-financials-reported-
// based reconstruction (see buildBankRevenueGrowthSeries/
// buildBankProfitMarginSeries/buildFcfMarginFromFilings in the main app's
// src/utils/metrics.js) — that endpoint only carries US-GAAP XBRL from
// 10-K/10-Q filings. Foreign private issuers file 40-F/20-F + 6-K instead,
// and Finnhub simply doesn't crawl those forms (verified live: zero entries
// for Bank of Montreal/BMO and IAMGOLD/IAG on that endpoint).
//
// The data genuinely exists for free on SEC's OWN public EDGAR API
// (data.sec.gov/api/xbrl/companyfacts) — foreign issuers reporting under
// IFRS have been required to tag financial statements in Inline XBRL using
// the `ifrs-full` taxonomy since ~2018. Verified live for two independent
// filers in different industries/countries (BMO - Canadian bank, IAG -
// Canadian mining) that the concept names below are consistent.
//
// Two structural differences from the US-GAAP pipeline (both verified
// live), handled here:
//   1. Periods aren't always YTD-cumulative — some filers (BMO) tag the
//      standalone 3-month figure directly as its own fact, alongside a
//      separate longer YTD figure. Classified by duration instead of
//      assumed either way.
//   2. The same period appears multiple times across different accession
//      numbers (a later filing's comparative column echoing a prior
//      period) — deduped by preferring the most-recently-`filed` value for
//      a given (start, end) pair.
// Fiscal year-ends don't all align to the calendar (BMO's fiscal year ends
// Oct 31) — quarters are sequenced by actual date continuity, not a
// (year, quarter-number) scheme, but each point's LABEL is still derived
// from its end-date's calendar quarter, which keeps output compatible with
// stock-analyzer's existing label-parsing code (hasInternalGaps,
// pickBetterTrend) with zero changes needed there.
//
// Runs in its own public repo (unlimited free GitHub Actions minutes, same
// reasoning as stock-metrics-pipeline) and publishes to the SAME Gist
// stock-metrics-pipeline already publishes to, as a new file
// (foreignFilingsCache.json) — see .github/workflows/generate-foreign-
// filings-cache.yml for the one-time secret setup.

const fs = require('fs');
const path = require('path');

const OUTPUT_FILE = path.join(__dirname, '../foreignFilingsCache.json');
const GIST_METRICS_URL = 'https://gist.githubusercontent.com/jadrayes1/db6fbd96e980118d3c6a63965dc0dc39/raw/marketMetrics.json';
const GIST_FOREIGN_FILINGS_URL = 'https://gist.githubusercontent.com/jadrayes1/db6fbd96e980118d3c6a63965dc0dc39/raw/foreignFilingsCache.json';
const SEC_TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';
const SEC_COMPANYFACTS_BASE = 'https://data.sec.gov/api/xbrl/companyfacts';
// SEC's fair-use policy asks for a descriptive User-Agent identifying the
// requester and a real contact — this is NOT an API key, just good-citizen
// identification; see https://www.sec.gov/os/webmaster-faq#developers
const SEC_USER_AGENT = 'stock-analyzer-app foreign-filings-pipeline contact:jadrayescpp@gmail.com';
const REQUEST_SPACING_MS = 200; // well under SEC's documented ~10 req/sec fair-use guidance
const QUARTERS_OF_HISTORY = 12; // mirrors src/utils/metrics.js

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': SEC_USER_AGENT, Accept: 'application/json' } });
  if (!res.ok) {
    if (res.status === 404) return null; // no CIK match / no facts filed — a normal outcome, not an error
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

// ---------------------------------------------------------------------------
// IFRS concept extraction — see file header for how these were verified.
// ---------------------------------------------------------------------------

const REVENUE_CONCEPTS = ['Revenue'];
const OCF_CONCEPTS = ['CashFlowsFromUsedInOperatingActivities'];
const CAPEX_CONCEPTS = [
  'PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities',
  'PurchaseOfPropertyPlantAndEquipmentIntangibleAssetsOtherThanGoodwillInvestmentPropertyAndOtherNoncurrentAssets',
];
const NET_INCOME_CONCEPTS = ['ProfitLoss'];
const SHARES_CONCEPTS = ['WeightedAverageShares'];

// Searches ifrs-full first (what every foreign filer verified so far uses),
// then us-gaap as a defensive fallback in case a filer mixes taxonomies —
// returns the raw fact array (list of {start,end,val,filed,accn,form,fp,fy})
// for the first matching concept with real data, across any reported unit
// (currency doesn't matter here — every ratio computed below is dimension-
// less or a self-relative percentage, so no cross-currency conversion is
// ever needed as long as a single company's own concepts share one currency,
// which they do).
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

// Dedupes by (start, end) — preferring the most-recently-`filed` value, since
// the same period is often re-reported as a comparative column in a later
// filing (verified live for both BMO and IAG) — then classifies each
// surviving fact as a standalone quarter (~80-100 day span) or annual
// (~350-380 days); anything else (semi-annual, odd stub periods) is
// dropped rather than guessed at.
function dedupeAndClassify(rawFacts) {
  const byPeriod = new Map();
  for (const fact of rawFacts) {
    if (fact.value == null && fact.val == null) continue;
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

// Two standalone quarters are "adjacent" if the next one's start is within a
// few days of the previous one's end — actual date continuity, not a
// (year, quarter-number) scheme, since fiscal year-ends don't all align to
// the calendar (verified live: BMO's fiscal year ends Oct 31).
function isAdjacent(prevEnd, currStart) {
  const gapDays = daysBetween(prevEnd, currStart);
  return gapDays >= -5 && gapDays <= 5;
}

// Mirrors buildTrailingWindows in the main app's src/utils/metrics.js — see
// that file for the full rationale (a full 4-quarter run isn't always
// available; fall back to a shorter consecutive run rather than emit
// nothing, flagged `partial: true`). Adapted here to use date-continuity
// adjacency (isAdjacent) instead of calendar quarter-number adjacency.
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

// A margin or growth rate beyond +/-1000% is essentially always a near-zero-
// denominator artifact (verified live: Denison Mines/DNN's FY'23 profit
// margin computes to +4870%, Cardiol/CRDL's FY'21 to -40,170% — both tiny/
// early-stage companies where a normal-sized net loss or FCF figure divided
// by a near-zero revenue produces a mathematically "correct" but meaningless
// number), not a real, useful signal — same reasoning as the sanity guards
// already applied to the DCF fair-value estimate elsewhere in this project.
// Dropped (null) rather than published, same as any other uncomputable point.
const MAX_ABS_RATIO = 10; // 1000%
function clampImplausible(value) {
  return value != null && Math.abs(value) <= MAX_ABS_RATIO ? value : null;
}

function buildRatioTrend(numeratorQuarters, denominatorQuarters, combine) {
  const denomByEnd = new Map(denominatorQuarters.map((q) => [q.end, q]));
  const standalone = numeratorQuarters.filter((q) => denomByEnd.has(q.end)).map((q) => ({ ...q, other: denomByEnd.get(q.end).value }));

  return buildTrailingWindows(standalone, 4)
    .map(({ quarters, anchor, partial }) => {
      const value = clampImplausible(combine(quarters, anchor));
      return { label: quarterLabelFromDate(anchor.end), value, partial, quartersUsed: quarters.length };
    })
    .filter((p) => p.value != null)
    .slice(-QUARTERS_OF_HISTORY);
}

function buildRevenueGrowthTrend(revenueQuarterly) {
  // YoY vs. the standalone quarter ~1 year prior (closest match within a
  // ~30-day tolerance around the 1-year mark, since fiscal quarter-ends can
  // drift slightly year to year for some filers).
  const points = [];
  for (let i = 0; i < revenueQuarterly.length; i++) {
    const curr = revenueQuarterly[i];
    const targetPriorEnd = new Date(curr.end);
    targetPriorEnd.setUTCFullYear(targetPriorEnd.getUTCFullYear() - 1);
    let best = null;
    let bestDiff = Infinity;
    for (const cand of revenueQuarterly) {
      const diff = Math.abs(new Date(cand.end) - targetPriorEnd);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = cand;
      }
    }
    const withinTolerance = bestDiff <= 30 * 24 * 60 * 60 * 1000;
    const value = clampImplausible(withinTolerance && best && best.value ? (curr.value - best.value) / best.value : null);
    if (value != null) points.push({ label: quarterLabelFromDate(curr.end), value, partial: false, quartersUsed: 1 });
  }
  return points.slice(-QUARTERS_OF_HISTORY);
}

// ---------------------------------------------------------------------------
// ANNUAL-cadence fallback — some filers (verified live: IAMGOLD/IAG,
// Nordicus/CNEY, Denison Mines/DNN, Cardiol/CRDL) tag few or zero
// standalone-QUARTER facts in their SEC XBRL at all, but do have real
// ANNUAL facts. Rather than show nothing for these, fall back to a
// once-a-year trend — clearly labeled "FY 'YY" (not "Q# 'YY") so it's never
// confused with a quarterly figure downstream (the app's own gap-detection/
// label-parsing code only recognizes the "Q# 'YY" shape, so an annual label
// safely no-ops through that logic rather than being misread as a weird
// quarterly gap). No TTM windowing needed here — each annual fact is
// already a complete, self-contained full-year figure.
// ---------------------------------------------------------------------------

function annualLabelFromDate(dateStr) {
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return null;
  return `FY '${String(d.getUTCFullYear()).slice(-2)}`;
}

function buildAnnualRevenueGrowthTrend(revenueAnnual) {
  const points = [];
  for (let i = 1; i < revenueAnnual.length; i++) {
    const curr = revenueAnnual[i];
    const prev = revenueAnnual[i - 1];
    const gapDays = daysBetween(prev.end, curr.end);
    if (gapDays < 350 || gapDays > 380) continue; // not genuinely consecutive fiscal years
    const value = clampImplausible(prev.value ? (curr.value - prev.value) / prev.value : null);
    if (value != null) points.push({ label: annualLabelFromDate(curr.end), value, partial: false });
  }
  return points.slice(-QUARTERS_OF_HISTORY);
}

function buildAnnualRatioTrend(numeratorAnnual, denominatorAnnual, combine) {
  const denomByEnd = new Map(denominatorAnnual.map((q) => [q.end, q.value]));
  return numeratorAnnual
    .filter((q) => denomByEnd.has(q.end))
    .map((q) => ({ label: annualLabelFromDate(q.end), value: clampImplausible(combine(q.value, denomByEnd.get(q.end))), partial: false }))
    .filter((p) => p.value != null)
    .slice(-QUARTERS_OF_HISTORY);
}

// A fresh attempt can come back empty or narrower on a day where SEC has a
// transient hiccup for this specific filer — mirrors pickTrendToPublish in
// the main pipeline's generateSectorMetrics.js.
function pickTrendToPublish(existingPoints, freshPoints) {
  if (!freshPoints || freshPoints.length === 0) return existingPoints || [];
  if (!existingPoints || existingPoints.length === 0) return freshPoints;
  const existingLabels = new Set(existingPoints.map((p) => p.label));
  const hasNewQuarter = freshPoints.some((p) => !existingLabels.has(p.label));
  return hasNewQuarter ? freshPoints : existingPoints;
}

async function fetchPreviouslyPublished() {
  try {
    const data = await fetchJson(GIST_FOREIGN_FILINGS_URL);
    return data?.trends && typeof data.trends === 'object' ? data.trends : {};
  } catch {
    return {};
  }
}

function isFinancialIndustry(industry) {
  return !!industry && ['Banking', 'Insurance', 'Financial Services'].includes(industry);
}

async function processTicker(symbol, cik) {
  const companyFacts = await fetchJson(`${SEC_COMPANYFACTS_BASE}/CIK${cik}.json`);
  if (!companyFacts) return null;

  const revenueRaw = extractFactSeries(companyFacts, REVENUE_CONCEPTS);
  const ocfRaw = extractFactSeries(companyFacts, OCF_CONCEPTS);
  const capexRaw = extractFactSeries(companyFacts, CAPEX_CONCEPTS);
  const netIncomeRaw = extractFactSeries(companyFacts, NET_INCOME_CONCEPTS);

  const revenue = dedupeAndClassify(revenueRaw);
  const ocf = dedupeAndClassify(ocfRaw);
  const capex = dedupeAndClassify(capexRaw);
  const netIncome = dedupeAndClassify(netIncomeRaw);

  const result = {};

  if (revenue.quarterly.length) {
    result.revenueGrowth = buildRevenueGrowthTrend(revenue.quarterly);
  }
  if (!result.revenueGrowth?.length && revenue.annual.length) {
    result.revenueGrowth = buildAnnualRevenueGrowthTrend(revenue.annual);
  }

  if (netIncome.quarterly.length && revenue.quarterly.length) {
    result.profitMargin = buildRatioTrend(netIncome.quarterly, revenue.quarterly, (quarters) => {
      const income = quarters.reduce((sum, q) => sum + q.value, 0);
      const rev = quarters.reduce((sum, q) => sum + q.other, 0);
      return rev ? income / rev : null;
    });
  }
  if (!result.profitMargin?.length && netIncome.annual.length && revenue.annual.length) {
    result.profitMargin = buildAnnualRatioTrend(netIncome.annual, revenue.annual, (income, rev) => (rev ? income / rev : null));
  }

  if (ocf.quarterly.length && capex.quarterly.length && revenue.quarterly.length) {
    const capexByEnd = new Map(capex.quarterly.map((q) => [q.end, q.value]));
    const ocfWithCapex = ocf.quarterly.filter((q) => capexByEnd.has(q.end)).map((q) => ({ ...q, value: q.value - capexByEnd.get(q.end) }));
    result.fcfMargin = buildRatioTrend(ocfWithCapex, revenue.quarterly, (quarters) => {
      const fcf = quarters.reduce((sum, q) => sum + q.value, 0);
      const rev = quarters.reduce((sum, q) => sum + q.other, 0);
      return rev ? fcf / rev : null;
    });
  }
  if (!result.fcfMargin?.length && ocf.annual.length && capex.annual.length && revenue.annual.length) {
    const capexByEnd = new Map(capex.annual.map((q) => [q.end, q.value]));
    const ocfWithCapexAnnual = ocf.annual.filter((q) => capexByEnd.has(q.end)).map((q) => ({ ...q, value: q.value - capexByEnd.get(q.end) }));
    result.fcfMargin = buildAnnualRatioTrend(ocfWithCapexAnnual, revenue.annual, (fcf, rev) => (rev ? fcf / rev : null));
  }

  for (const key of Object.keys(result)) {
    if (!result[key]?.length) delete result[key];
  }
  return Object.keys(result).length ? result : null;
}

async function main() {
  console.log('Fetching ticker universe from the published sector-metrics feed and SEC ticker->CIK map...');
  const [metricsDataset, tickerToCik, previouslyPublished] = await Promise.all([
    fetchJson(GIST_METRICS_URL),
    fetchTickerToCikMap(),
    fetchPreviouslyPublished(),
  ]);

  const candidates = Object.entries(metricsDataset.metrics || {})
    .filter(([, data]) => data.revenueGrowth == null || data.profitMargin == null)
    .map(([symbol, data]) => ({ symbol, industry: data.industry }));

  const withCik = candidates.map((c) => ({ ...c, cik: tickerToCik.get(c.symbol) })).filter((c) => c.cik);
  console.log(
    `${candidates.length} tickers missing revenueGrowth or profitMargin; ${withCik.length} of those have a matching SEC CIK ` +
      `(the rest are either genuinely too new, or not SEC-registered at all).`
  );

  const trends = { ...previouslyPublished };
  let processed = 0;
  let resolved = 0;

  for (const { symbol, cik, industry } of withCik) {
    let fresh = null;
    try {
      fresh = await processTicker(symbol, cik);
    } catch (err) {
      console.log(`  skip ${symbol}: ${err.message}`);
    }
    await sleep(REQUEST_SPACING_MS);

    if (fresh) {
      const merged = { ...(trends[symbol] || {}) };
      for (const key of ['revenueGrowth', 'profitMargin', 'fcfMargin']) {
        if (key === 'fcfMargin' && isFinancialIndustry(industry)) continue; // not a meaningful concept for banks
        if (fresh[key]) merged[key] = pickTrendToPublish(merged[key], fresh[key]);
      }
      if (Object.keys(merged).length) {
        trends[symbol] = merged;
        resolved++;
      }
    }

    processed++;
    if (processed % 50 === 0) console.log(`  ${processed}/${withCik.length} processed (${resolved} resolved so far)`);
  }

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify({ generatedAt: new Date().toISOString(), trends }));
  console.log(`Done. Processed ${processed} tickers, ${resolved} resolved to at least one trend. Cache now covers ${Object.keys(trends).length} tickers total.`);
}

module.exports = {
  extractFactSeries,
  dedupeAndClassify,
  buildTrailingWindows,
  buildRatioTrend,
  buildRevenueGrowthTrend,
  buildAnnualRevenueGrowthTrend,
  buildAnnualRatioTrend,
  isAdjacent,
  quarterLabelFromDate,
  annualLabelFromDate,
  processTicker,
};

if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
