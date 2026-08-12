// scripts/generateForeignFilingsCache.js
//
// Reconstructs revenue-growth, profit-margin, FCF-margin, and ROIC trends
// for FOREIGN-FILER tickers (Canadian banks/miners, UK pharma, etc.) that
// have no data at all from stock-analyzer's existing Finnhub-financials-
// reported-based reconstruction (see buildBankRevenueGrowthSeries/
// buildBankProfitMarginSeries/buildFcfMarginFromFilings/
// buildRoicTrendFromFilings in the main app's src/utils/metrics.js) — that
// endpoint only carries US-GAAP XBRL from 10-K/10-Q filings. Foreign
// private issuers file 40-F/20-F + 6-K instead, and Finnhub simply doesn't
// crawl those forms (verified live: zero entries for Bank of Montreal/BMO
// and IAMGOLD/IAG on that endpoint).
//
// P/FCF is NOT included here — see generateForeignPfcfCache.js, a separate
// script/workflow in this same repo, since that one needs Twelve Data
// price history on top of SEC data (its own rate-limit budget), the same
// reason generatePfcfTrendCache.js is split from generateSectorMetrics.js
// in the stock-metrics-pipeline repo.
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
const { extractQuarterlyFactsFromFilings } = require('./lib/extractFilingTextFacts');
const { fetchBusinessQuantFacts } = require('./lib/businessQuantFallback');

const OUTPUT_FILE = path.join(__dirname, '../foreignFilingsCache.json');
const GIST_METRICS_URL = 'https://gist.githubusercontent.com/jadrayes1/db6fbd96e980118d3c6a63965dc0dc39/raw/marketMetrics.json';
const GIST_FOREIGN_FILINGS_URL = 'https://gist.githubusercontent.com/jadrayes1/db6fbd96e980118d3c6a63965dc0dc39/raw/foreignFilingsCache.json';
// Published weekly by the separate discoverForeignFilers.js job/workflow —
// see that file's header for the full rationale. Read here so this DAILY
// job skips straight to extraction for a known list instead of re-deriving
// it from a full ~5,070-ticker classification scan every single day.
const GIST_FOREIGN_FILER_LIST_URL = 'https://gist.githubusercontent.com/jadrayes1/db6fbd96e980118d3c6a63965dc0dc39/raw/foreignFilerList.json';
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

// A network interruption mid-request can leave a bare `fetch()` (no
// default timeout) hanging forever rather than erroring — verified live
// this session in the sibling smart-money-pipeline repo (a run stalled at
// 0% CPU for 5+ hours after an apparent connectivity blip). 30s is
// generous for any single SEC request; a real timeout surfaces as a
// normal caught error instead of an indefinite hang that could burn a
// scheduled workflow's entire timeout budget on one stuck ticker.
const FETCH_TIMEOUT_MS = 30000;

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

// ROIC's inputs — verified live for two independent filers (BMO - Canadian
// bank, IAG - Canadian mining):
//   - EBIT: try genuine operating income first (ProfitLossFromOperating
//     Activities — present for IAG, a non-bank), fall back to pre-tax
//     income (ProfitLossBeforeTax — BMO has no operating-income concept at
//     all, same reason banks lack us-gaap_OperatingIncomeLoss under
//     US-GAAP: interest income/expense are core banking operations for a
//     bank, not a separate financing layer below an operating-income line
//     — see findReportedEBIT's identical fallback in the main app's
//     src/utils/metrics.js). A simple 2-concept candidate list suffices
//     here (no label-regex matching needed like the US-GAAP version) since
//     IFRS concept naming is far more standardized than US-GAAP's
//     per-filer extension concepts — both BMO and IAG use these exact
//     concept names, unlike BNY's company-specific bk_* extension.
//   - Equity/Cash/Debt: balance-sheet concepts, all INSTANT facts (a single
//     "as of" date, not a start/end period) — see dedupeInstantFacts below
//     for why these need different handling than the period-flow concepts
//     above. Deposits are deliberately NOT in DEBT_CONCEPTS, same principle
//     as the main pipeline's sumDebt: they fund the loan book as a normal
//     operating liability for a bank, not a financing choice, so bank
//     filers like BMO naturally get debt=0 without any special-casing.
const EBIT_CONCEPTS = ['ProfitLossFromOperatingActivities', 'ProfitLossBeforeTax'];
const EQUITY_CONCEPTS = ['Equity'];
const CASH_CONCEPTS = ['CashAndCashEquivalents'];
const DEBT_CONCEPTS = ['Borrowings', 'LongtermBorrowings', 'CurrentPortionOfLongtermBorrowings'];
const ROIC_ASSUMED_TAX_RATE = 0.21; // matches the main pipeline's own default simplification

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
// surviving fact as a standalone quarter (~80-100 day span), 6-month/9-month
// YTD-cumulative, or annual (~350-380 days).
//
// The 6mo/9mo facts are then DE-CUMULATED into standalone quarters wherever
// a genuine standalone fact isn't already tagged for that period — verified
// live: more than half of this pipeline's covered universe (AstraZeneca/AZN,
// Deutsche Bank/DB, Royal Bank of Canada/RY, Toronto-Dominion/TD, Total/TTE,
// Stellantis/STLA, and more) reports interim results as YTD-cumulative
// rather than tagging each standalone quarter directly, unlike BMO (which
// tags standalone quarters outright — see the file header). Matched by
// shared START date, since a YTD figure and the standalone quarters that
// make it up always begin at the same fiscal-year start. Mirrors
// decumulateYtdByYear in the main pipeline's generateSectorMetrics.js
// (US-GAAP, {year,quarter}-keyed) — same principle, adapted to this file's
// date-keyed fact shape. Only fills a GAP (no existing point for that
// end-date) — never overwrites a genuinely-tagged standalone fact, which is
// always preferred when both exist.
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
  const h1 = [];
  const q3ytd = [];
  const annual = [];
  for (const fact of byPeriod.values()) {
    const days = daysBetween(fact.start, fact.end);
    const point = { start: fact.start, end: fact.end, value: fact.val };
    if (days >= 80 && days <= 100) quarterly.push(point);
    else if (days >= 170 && days <= 200) h1.push(point);
    else if (days >= 260 && days <= 300) q3ytd.push(point);
    else if (days >= 350 && days <= 380) annual.push(point);
  }

  const hasEnd = (end) => quarterly.some((q) => q.end === end);
  const q1ByStart = new Map(quarterly.map((q) => [q.start, q]));
  const h1ByStart = new Map(h1.map((h) => [h.start, h]));
  const q3ByStart = new Map(q3ytd.map((q) => [q.start, q]));

  for (const h of h1) {
    const q1 = q1ByStart.get(h.start);
    if (q1 && !hasEnd(h.end)) quarterly.push({ start: q1.end, end: h.end, value: h.value - q1.value });
  }
  for (const q3 of q3ytd) {
    const half = h1ByStart.get(q3.start);
    if (half && !hasEnd(q3.end)) quarterly.push({ start: half.end, end: q3.end, value: q3.value - half.value });
  }
  for (const fy of annual) {
    const q3 = q3ByStart.get(fy.start);
    if (q3 && !hasEnd(fy.end)) quarterly.push({ start: q3.end, end: fy.end, value: fy.value - q3.value });
  }

  quarterly.sort((a, b) => new Date(a.end) - new Date(b.end));
  annual.sort((a, b) => new Date(a.end) - new Date(b.end));
  return { quarterly, annual };
}

// Balance-sheet concepts (Equity, Cash, Borrowings) are INSTANT facts — a
// single "as of" date, not a start/end period (verified live: no `start`
// field on any of these in BMO's or IAG's raw data). dedupeAndClassify
// above assumes period-flow facts and would silently drop every instant
// fact if reused as-is (daysBetween needs both a start and end). Dedupes
// by end date only, same most-recently-`filed` conflict-resolution rule as
// dedupeAndClassify — no quarterly/annual split needed, since joining by
// end-date against an EBIT quarterly or annual point naturally picks out
// the right one either way.
function dedupeInstantFacts(rawFacts) {
  const byDate = new Map();
  for (const fact of rawFacts) {
    if (fact.val == null || !fact.end) continue;
    const existing = byDate.get(fact.end);
    if (!existing || new Date(fact.filed) > new Date(existing.filed)) {
      byDate.set(fact.end, fact);
    }
  }
  return Array.from(byDate.values())
    .map((f) => ({ end: f.end, value: f.val }))
    .sort((a, b) => new Date(a.end) - new Date(b.end));
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

// Single STANDALONE quarter (no trailing window) — the Quarterly-cadence
// counterpart to buildRatioTrend's TTM windowing above. Mirrors the main
// app's buildBankProfitMarginSeries/buildFcfMarginQuarterlyFromFilings
// (src/utils/metrics.js): each quarter's own numerator divided by that same
// quarter's own denominator, joined by end-date.
function buildQuarterlyRatioTrend(numeratorQuarters, denominatorQuarters, combine) {
  const denomByEnd = new Map(denominatorQuarters.map((q) => [q.end, q.value]));
  return numeratorQuarters
    .filter((q) => denomByEnd.has(q.end))
    .map((q) => ({ label: quarterLabelFromDate(q.end), value: clampImplausible(combine(q.value, denomByEnd.get(q.end))) }))
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

// TTM-cadence revenue growth — YoY on a trailing-4-quarter-SUMMED revenue
// figure rather than a single standalone quarter, mirroring the main app's
// buildRevenueGrowthTTMFromFilings (src/utils/metrics.js). Only non-partial
// (a full 4 consecutive quarters) windows are used — a partial TTM sum isn't
// meaningfully comparable YoY against another partial sum.
function buildRevenueGrowthTTMTrend(revenueQuarterly) {
  const windows = buildTrailingWindows(revenueQuarterly, 4).filter((w) => !w.partial);
  const ttmPoints = windows.map((w) => ({ end: w.anchor.end, value: w.quarters.reduce((sum, q) => sum + q.value, 0) }));

  const points = [];
  for (const curr of ttmPoints) {
    const targetPriorEnd = new Date(curr.end);
    targetPriorEnd.setUTCFullYear(targetPriorEnd.getUTCFullYear() - 1);
    let best = null;
    let bestDiff = Infinity;
    for (const cand of ttmPoints) {
      const diff = Math.abs(new Date(cand.end) - targetPriorEnd);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = cand;
      }
    }
    const withinTolerance = bestDiff <= 30 * 24 * 60 * 60 * 1000;
    const value = clampImplausible(withinTolerance && best && best.value ? (curr.value - best.value) / best.value : null);
    if (value != null) points.push({ label: quarterLabelFromDate(curr.end), value });
  }
  return points.slice(-QUARTERS_OF_HISTORY);
}

// ---------------------------------------------------------------------------
// ANNUAL-cadence builder — powers the Yearly tab directly, and also serves
// as the effective fallback for filers that tag few or zero standalone-
// QUARTER facts in their SEC XBRL at all (verified live: IAMGOLD/IAG,
// Nordicus/CNEY, Denison Mines/DNN, Cardiol/CRDL) but do have real ANNUAL
// facts — those tickers simply end up with only a `yearly` entry and no
// `quarterly`/`ttm` ones, same principle as any other cadence with
// insufficient underlying data. Labeled "FY 'YY" (not "Q# 'YY") so it's
// never confused with a quarterly figure downstream (the app's own gap-
// detection/label-parsing code only recognizes the "Q# 'YY" shape, so an
// annual label safely no-ops through that logic rather than being misread
// as a weird quarterly gap). No TTM windowing needed here — each annual
// fact is already a complete, self-contained full-year figure.
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

// ---------------------------------------------------------------------------
// ROIC — NOPAT / (debt + equity - cash). Mirrors buildRoicQuarterlyFromFilings/
// buildRoicYearlyFromFilings/buildRoicTTMFromFilings in the main pipeline's
// generateSectorMetrics.js exactly (same annualization/windowing logic),
// adapted to this file's end-date-keyed point shape instead of {year,quarter}
// report objects. Invested capital is computed ONCE, keyed by end-date,
// from the flat (not quarterly/annual-split) equity/cash/debt instant
// series — an EBIT quarterly point and an EBIT annual point naturally pick
// out the right balance-sheet snapshot just by matching end-date, no
// separate quarterly/annual invested-capital computation needed.
// ---------------------------------------------------------------------------

function investedCapitalByEnd(equityInstant, cashInstant, debtInstant, isBank) {
  const cashByEnd = new Map(cashInstant.map((f) => [f.end, f.value]));
  const debtByEnd = new Map(debtInstant.map((f) => [f.end, f.value]));
  const map = new Map();
  for (const e of equityInstant) {
    // Cash isn't netted out for bank filers — verified live: BMO's IFRS
    // CashAndCashEquivalents ($67.4B) includes central-bank reserves and
    // interbank deposits, a bank's core OPERATING assets, not idle/excess
    // cash the way it is for an industrial company. Subtracting it
    // collapsed invested capital to ~$20.7B against $88.1B of real equity,
    // inflating ROIC to 34-57% for a company whose real ROIC is ~3%. Debt
    // is untouched (already effectively 0 for banks — see DEBT_CONCEPTS'
    // deliberate exclusion of deposits above).
    const cash = isBank ? 0 : cashByEnd.get(e.end) || 0;
    const debt = debtByEnd.get(e.end) || 0;
    const investedCapital = debt + e.value - cash;
    if (investedCapital > 0) map.set(e.end, investedCapital);
  }
  return map;
}

function buildRoicQuarterlyTrend(ebitQuarterly, investedCapitalMap) {
  return ebitQuarterly
    .filter((q) => investedCapitalMap.has(q.end))
    .map((q) => {
      // Annualized (x4) — EBIT/NOPAT is a flow figure that shrinks to ~1/4
      // at quarterly granularity, but invested capital is a point-in-time
      // balance-sheet snapshot that doesn't shrink with it; see the
      // identical note in the main pipeline's buildRoicQuarterlyFromFilings.
      const annualizedNopat = q.value * (1 - ROIC_ASSUMED_TAX_RATE) * 4;
      const value = clampImplausible(annualizedNopat / investedCapitalMap.get(q.end));
      return value != null ? { label: quarterLabelFromDate(q.end), value } : null;
    })
    .filter(Boolean)
    .slice(-QUARTERS_OF_HISTORY);
}

function buildRoicYearlyTrend(ebitAnnual, investedCapitalMap) {
  return ebitAnnual
    .filter((a) => investedCapitalMap.has(a.end))
    .map((a) => {
      const nopat = a.value * (1 - ROIC_ASSUMED_TAX_RATE);
      const value = clampImplausible(nopat / investedCapitalMap.get(a.end));
      return value != null ? { label: annualLabelFromDate(a.end), value } : null;
    })
    .filter(Boolean)
    .slice(-QUARTERS_OF_HISTORY);
}

function buildRoicTTMTrend(ebitQuarterly, investedCapitalMap) {
  const standalone = ebitQuarterly
    .filter((q) => investedCapitalMap.has(q.end))
    .map((q) => ({ start: q.start, end: q.end, nopat: q.value * (1 - ROIC_ASSUMED_TAX_RATE), investedCapital: investedCapitalMap.get(q.end) }));

  return buildTrailingWindows(standalone, 4)
    .map(({ quarters, anchor, partial }) => {
      const rawNopat = quarters.reduce((sum, q) => sum + q.nopat, 0);
      // A partial window (< 4 quarters) sums fewer than a full year of
      // NOPAT, but investedCapital is still a full-year-scale balance-sheet
      // snapshot — left unannualized, a 1-quarter partial window understates
      // ROIC ~4x relative to a genuine trailing-twelve-month figure (same
      // reasoning buildRoicQuarterlyTrend already applies to a single
      // quarter). Verified live: PLG's sole Q4'19 quarter produced ttm.roic
      // of 284% (raw, unannualized) that slipped under the +/-1000% sanity
      // clamp, while the SAME quarter's properly-annualized quarterly.roic
      // (1137%) was correctly clamped as implausible — an inconsistency
      // that let a misleadingly-labeled "TTM" figure survive as the only
      // cadence with data for that ticker.
      const ttmNopat = partial ? rawNopat * (4 / quarters.length) : rawNopat;
      const value = clampImplausible(ttmNopat / anchor.investedCapital);
      return value != null ? { label: quarterLabelFromDate(anchor.end), value, partial, quartersUsed: quarters.length } : null;
    })
    .filter(Boolean)
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

// Migrates a pre-cadence-caching entry (flat { revenueGrowth, profitMargin,
// fcfMargin } arrays, published before Quarterly/Yearly/TTM were tracked
// separately) into the new { quarterly, yearly, ttm } shape, so the
// transitional run doesn't look like data vanished. revenueGrowth's old
// computation (buildRevenueGrowthTrend) was always a single standalone
// quarter — maps to `quarterly`. profitMargin/fcfMargin's old computation
// (buildRatioTrend) was always a trailing-4-quarter window — maps to `ttm`.
// Mirrors the equivalent migration in the main pipeline's
// generateSectorMetrics.js. A no-op on an entry that's already the new
// shape (detected by the presence of any of the three cadence keys, which
// never appear on a legacy entry).
//
// EXCEPT: a brief window of legacy entries (published between bd077cd and
// 25bd637) could ALSO hold the annual-cadence fallback that bd077cd added —
// same flat field names, but labeled "FY 'YY" (via annualLabelFromDate),
// deliberately distinguishable from the quarterly-shaped "Q# 'YY" labels
// this function otherwise assumes. Blindly mapping those into
// `quarterly`/`ttm` mislabels annual figures as quarterly/TTM ones —
// verified live: 279 (ticker, cadence, metric) combos in the published
// cache carried nothing but "FY 'YY"-labeled points inside `ttm`/`quarterly`
// this way. Those points are dropped here rather than relabeled into
// `yearly`, since processTicker already computes a real `yearly` entry
// fresh from current annual facts every run — no data is lost, only the
// mislabeled duplicate is discarded.
function migrateLegacyEntry(entry) {
  if (!entry) return {};
  if (entry.quarterly || entry.yearly || entry.ttm) return entry;
  const isQuarterlyShaped = (points) => Array.isArray(points) && points.length && points.every((p) => !p.label || !p.label.startsWith("FY '"));
  const migrated = {};
  if (isQuarterlyShaped(entry.revenueGrowth)) {
    migrated.quarterly = { revenueGrowth: entry.revenueGrowth };
  }
  if (isQuarterlyShaped(entry.profitMargin)) {
    migrated.ttm = { ...(migrated.ttm || {}), profitMargin: entry.profitMargin };
  }
  if (isQuarterlyShaped(entry.fcfMargin)) {
    migrated.ttm = { ...(migrated.ttm || {}), fcfMargin: entry.fcfMargin };
  }
  return migrated;
}

// Strips any "FY 'YY"-labeled point out of a quarterly/ttm points array.
// Guards against a one-time migration bug (see migrateLegacyEntry's comment)
// whose mislabeled output already "graduated" into the new { quarterly,
// yearly, ttm } shape in a past run — once there, migrateLegacyEntry's own
// early-return (`if (entry.quarterly || ...) return entry`) never sees it
// again, so merge-protection alone would otherwise preserve the mislabeled
// points forever. yearly is untouched — "FY 'YY" is the correct label
// there.
function sanitizeCadencePoints(cadence, points) {
  if (cadence === 'yearly' || !Array.isArray(points)) return points;
  return points.filter((p) => !p.label || !p.label.startsWith("FY '"));
}

// Per-(cadence, metric) merge-protection — a fresh run that comes back
// empty or narrower for one specific cadence/metric combo (a transient SEC
// hiccup for this filer) never overwrites a previously-published better
// result for that same combo, mirroring pickCadenceTrendsToPublish in the
// main pipeline's generatePfcfTrendCache.js.
function pickCadenceTrendsToPublish(existingEntry, freshEntry) {
  const existing = migrateLegacyEntry(existingEntry);
  const out = {};
  for (const cadence of ['quarterly', 'yearly', 'ttm']) {
    const merged = {};
    for (const key of ['revenueGrowth', 'profitMargin', 'fcfMargin', 'roic']) {
      const existingPoints = sanitizeCadencePoints(cadence, existing[cadence]?.[key]);
      const picked = pickTrendToPublish(existingPoints, freshEntry?.[cadence]?.[key]);
      if (picked.length) merged[key] = picked;
    }
    if (Object.keys(merged).length) out[cadence] = merged;
  }
  return out;
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

// Returns { quarterly, yearly, ttm }, each an object keyed by
// revenueGrowth/profitMargin/fcfMargin (only the ones with enough
// underlying data to compute) — each cadence stands on its own, computed
// independently from the same already-fetched facts, rather than the old
// single "best" series picked by a preferQuarterly flag. A filer like
// IAMGOLD/IAG (stale 2016-17 quarterly facts, current annual facts all the
// way to FY'25) simply ends up with a real `yearly` entry and empty
// `quarterly`/`ttm` ones — no special-casing needed, since a builder with
// insufficient input data naturally returns no points.
async function processTicker(symbol, cik, isBank) {
  const companyFacts = await fetchJson(`${SEC_COMPANYFACTS_BASE}/CIK${cik}.json`);
  if (!companyFacts) return null;

  // Only genuine IFRS filers — a domestic US-GAAP filer's SEC companyfacts
  // ALSO has real data (every US public company files US-GAAP XBRL with
  // SEC too, foreign or not), so without this check extractFactSeries's
  // us-gaap fallback would happily reconstruct trends for literally every
  // SEC-registered company, duplicating what the main stock-metrics-
  // pipeline repo already does via Finnhub — this pipeline exists
  // specifically for the foreign-filer gap Finnhub's own financials-
  // reported endpoint has, not as a general SEC-based alternative to it.
  // Checked here (before any concept extraction) rather than via a
  // candidate-list prefilter in main() — see that function's own comment
  // for why card-value nullness turned out to be the wrong signal
  // (verified live: Scorpio Tankers/STNG is a genuine IFRS filer whose
  // Finnhub NATIVE data happens to be fully populated, so it was never
  // flagged as a "gap" ticker despite having zero Quarterly/Yearly
  // reconstruction available from either pipeline).
  if (!companyFacts.facts?.['ifrs-full'] || !Object.keys(companyFacts.facts['ifrs-full']).length) return null;

  const revenueRaw = extractFactSeries(companyFacts, REVENUE_CONCEPTS);
  const ocfRaw = extractFactSeries(companyFacts, OCF_CONCEPTS);
  const capexRaw = extractFactSeries(companyFacts, CAPEX_CONCEPTS);
  const netIncomeRaw = extractFactSeries(companyFacts, NET_INCOME_CONCEPTS);
  const ebitRaw = extractFactSeries(companyFacts, EBIT_CONCEPTS);
  const equityRaw = extractFactSeries(companyFacts, EQUITY_CONCEPTS);
  const cashRaw = extractFactSeries(companyFacts, CASH_CONCEPTS);
  const debtRaw = extractFactSeries(companyFacts, DEBT_CONCEPTS);

  let revenue = dedupeAndClassify(revenueRaw);
  let ocf = dedupeAndClassify(ocfRaw);
  let capex = dedupeAndClassify(capexRaw);
  let netIncome = dedupeAndClassify(netIncomeRaw);
  const ebit = dedupeAndClassify(ebitRaw);

  // Fallback: for tickers whose SEC XBRL genuinely has zero standalone-
  // quarter facts (foreign private issuers are exempt from 10-Q filing —
  // verified live this is ~252 of 356 currently-published tickers), fill
  // the gap from the same company's SEC 6-K earnings-release exhibits —
  // real numbers, free, just prose/HTML instead of tagged XBRL. See
  // scripts/lib/extractFilingTextFacts.js for the full extraction/
  // reconciliation design. STRICTLY additive and gated:
  //   - opt-in via ENABLE_FILING_TEXT_FALLBACK (unset in the daily
  //     scheduled workflow — this is a heavier, higher-risk data source
  //     than structured XBRL, staged behind manual workflow_dispatch runs
  //     against a small sample first, per the rollout plan)
  //   - only attempted per-concept when XBRL quarterly is confirmed empty
  //     AND annual has real data (a verification anchor); a concept with
  //     working XBRL quarterly data is never touched
  //   - the extractor itself never returns an unverified point (see its
  //     own reconciliation checks) — this integration only decides WHEN
  //     to ask, not whether to trust what comes back
  if (process.env.ENABLE_FILING_TEXT_FALLBACK) {
    const allowlist = process.env.FILING_TEXT_FALLBACK_TICKERS
      ? new Set(process.env.FILING_TEXT_FALLBACK_TICKERS.split(',').map((s) => s.trim().toUpperCase()))
      : null;
    if (!allowlist || allowlist.has(symbol.toUpperCase())) {
      const needed = [];
      if (!revenue.quarterly.length && revenue.annual.length) needed.push('revenue');
      if (!netIncome.quarterly.length && netIncome.annual.length) needed.push('netIncome');
      if (!ocf.quarterly.length && ocf.annual.length) needed.push('ocf');
      if (!capex.quarterly.length && capex.annual.length) needed.push('capex');

      if (needed.length) {
        const annualByEnd = {
          revenue: new Map(revenue.annual.map((a) => [a.end, a])),
          netIncome: new Map(netIncome.annual.map((a) => [a.end, a])),
          ocf: new Map(ocf.annual.map((a) => [a.end, a])),
          capex: new Map(capex.annual.map((a) => [a.end, a])),
        };
        let filingTextFacts = {};
        try {
          filingTextFacts = await extractQuarterlyFactsFromFilings(cik, needed, annualByEnd, SEC_USER_AGENT);
        } catch (err) {
          console.warn(`  filing-text fallback failed for ${symbol}: ${err.message}`);
        }
        if (filingTextFacts.revenue?.length) revenue = dedupeAndClassify([...revenueRaw, ...filingTextFacts.revenue]);
        if (filingTextFacts.netIncome?.length) netIncome = dedupeAndClassify([...netIncomeRaw, ...filingTextFacts.netIncome]);
        if (filingTextFacts.ocf?.length) ocf = dedupeAndClassify([...ocfRaw, ...filingTextFacts.ocf]);
        // XBRL's capex concept is a positive magnitude (verified live:
        // IAG's FY2025 capex = 293,500,000) but the press-release table
        // reports it parenthesized/negative (a cash outflow) — negated
        // here to match XBRL's sign convention before merging, since
        // downstream fcfMargin math (ocf.value - capex.value) assumes it.
        if (filingTextFacts.capex?.length) {
          capex = dedupeAndClassify([...capexRaw, ...filingTextFacts.capex.map((f) => ({ ...f, val: -f.val }))]);
        }
      }
    }
  }

  // Last-resort standalone-quarter fallback via the BusinessQuant
  // fundamentals API — only for concepts STILL empty after both SEC XBRL
  // AND the 6-K filing-text fallback above (re-checked here since either
  // could have already filled a concept in). See lib/businessQuantFallback.js
  // for the full design rationale and the live cross-validation against EGO
  // this was built from (revenue/netIncome/ocf/capex all matched our own
  // independently-extracted values exactly for well-covered quarters; older
  // netIncome quarters for the same ticker were found to have real data-
  // quality problems on BusinessQuant's own side and were correctly rejected
  // by the same annual-reconciliation gate, not a false negative in our code).
  if (process.env.ENABLE_BUSINESSQUANT_FALLBACK && process.env.BUSINESSQUANT_API_KEY) {
    const allowlist = process.env.FILING_TEXT_FALLBACK_TICKERS
      ? new Set(process.env.FILING_TEXT_FALLBACK_TICKERS.split(',').map((s) => s.trim().toUpperCase()))
      : null;
    if (!allowlist || allowlist.has(symbol.toUpperCase())) {
      const stillNeeded = [];
      if (!revenue.quarterly.length && revenue.annual.length) stillNeeded.push('revenue');
      if (!netIncome.quarterly.length && netIncome.annual.length) stillNeeded.push('netIncome');
      if (!ocf.quarterly.length && ocf.annual.length) stillNeeded.push('ocf');
      if (!capex.quarterly.length && capex.annual.length) stillNeeded.push('capex');

      if (stillNeeded.length) {
        const annualByEnd = {
          revenue: new Map(revenue.annual.map((a) => [a.end, a])),
          netIncome: new Map(netIncome.annual.map((a) => [a.end, a])),
          ocf: new Map(ocf.annual.map((a) => [a.end, a])),
          capex: new Map(capex.annual.map((a) => [a.end, a])),
        };
        let bqFacts = {};
        try {
          bqFacts = await fetchBusinessQuantFacts(symbol, stillNeeded, annualByEnd, process.env.BUSINESSQUANT_API_KEY);
        } catch (err) {
          console.warn(`  BusinessQuant fallback failed for ${symbol}: ${err.message}`);
        }
        if (bqFacts.revenue?.length) revenue = dedupeAndClassify([...revenueRaw, ...bqFacts.revenue]);
        if (bqFacts.netIncome?.length) netIncome = dedupeAndClassify([...netIncomeRaw, ...bqFacts.netIncome]);
        if (bqFacts.ocf?.length) ocf = dedupeAndClassify([...ocfRaw, ...bqFacts.ocf]);
        // BusinessQuant's own capex sign already matches XBRL's convention
        // (negative = cash outflow) — verified live against EGO — no
        // negation needed here, unlike the 6-K text fallback above.
        if (bqFacts.capex?.length) capex = dedupeAndClassify([...capexRaw, ...bqFacts.capex]);
      }
    }
  }
  const equityInstant = dedupeInstantFacts(equityRaw);
  const cashInstant = dedupeInstantFacts(cashRaw);
  const debtInstant = dedupeInstantFacts(debtRaw);
  const investedCapitalMap = investedCapitalByEnd(equityInstant, cashInstant, debtInstant, isBank);

  const capexQByEnd = new Map(capex.quarterly.map((q) => [q.end, q.value]));
  const ocfWithCapexQuarterly = ocf.quarterly.filter((q) => capexQByEnd.has(q.end)).map((q) => ({ ...q, value: q.value - capexQByEnd.get(q.end) }));
  const capexAByEnd = new Map(capex.annual.map((q) => [q.end, q.value]));
  const ocfWithCapexAnnual = ocf.annual.filter((q) => capexAByEnd.has(q.end)).map((q) => ({ ...q, value: q.value - capexAByEnd.get(q.end) }));

  const quarterly = {};
  const yearly = {};
  const ttm = {};

  if (revenue.quarterly.length) {
    const rgQ = buildRevenueGrowthTrend(revenue.quarterly);
    if (rgQ.length) quarterly.revenueGrowth = rgQ;
    const rgTtm = buildRevenueGrowthTTMTrend(revenue.quarterly);
    if (rgTtm.length) ttm.revenueGrowth = rgTtm;
  }
  if (revenue.annual.length) {
    const rgY = buildAnnualRevenueGrowthTrend(revenue.annual);
    if (rgY.length) yearly.revenueGrowth = rgY;
  }

  if (netIncome.quarterly.length && revenue.quarterly.length) {
    const pmQ = buildQuarterlyRatioTrend(netIncome.quarterly, revenue.quarterly, (income, rev) => (rev ? income / rev : null));
    if (pmQ.length) quarterly.profitMargin = pmQ;
    const pmTtm = buildRatioTrend(netIncome.quarterly, revenue.quarterly, (quarters) => {
      const income = quarters.reduce((sum, q) => sum + q.value, 0);
      const rev = quarters.reduce((sum, q) => sum + q.other, 0);
      return rev ? income / rev : null;
    });
    if (pmTtm.length) ttm.profitMargin = pmTtm;
  }
  if (netIncome.annual.length && revenue.annual.length) {
    const pmY = buildAnnualRatioTrend(netIncome.annual, revenue.annual, (income, rev) => (rev ? income / rev : null));
    if (pmY.length) yearly.profitMargin = pmY;
  }

  // Not a meaningful concept for banks (see isFinancialIndustry) — skipped
  // for all 3 cadences there, same as the main pipeline's fcfMargin handling.
  if (!isBank) {
    if (ocfWithCapexQuarterly.length && revenue.quarterly.length) {
      const fmQ = buildQuarterlyRatioTrend(ocfWithCapexQuarterly, revenue.quarterly, (fcf, rev) => (rev ? fcf / rev : null));
      if (fmQ.length) quarterly.fcfMargin = fmQ;
      const fmTtm = buildRatioTrend(ocfWithCapexQuarterly, revenue.quarterly, (quarters) => {
        const fcf = quarters.reduce((sum, q) => sum + q.value, 0);
        const rev = quarters.reduce((sum, q) => sum + q.other, 0);
        return rev ? fcf / rev : null;
      });
      if (fmTtm.length) ttm.fcfMargin = fmTtm;
    }
    if (ocfWithCapexAnnual.length && revenue.annual.length) {
      const fmY = buildAnnualRatioTrend(ocfWithCapexAnnual, revenue.annual, (fcf, rev) => (rev ? fcf / rev : null));
      if (fmY.length) yearly.fcfMargin = fmY;
    }
  }

  // Not bank-gated, unlike fcfMargin above — verified live via the main
  // pipeline's identical BNY fix that ROIC (with the pre-tax-income EBIT
  // fallback) works fine for bank filers too.
  if (ebit.quarterly.length && investedCapitalMap.size) {
    const roicQ = buildRoicQuarterlyTrend(ebit.quarterly, investedCapitalMap);
    if (roicQ.length) quarterly.roic = roicQ;
    const roicTtm = buildRoicTTMTrend(ebit.quarterly, investedCapitalMap);
    if (roicTtm.length) ttm.roic = roicTtm;
  }
  if (ebit.annual.length && investedCapitalMap.size) {
    const roicY = buildRoicYearlyTrend(ebit.annual, investedCapitalMap);
    if (roicY.length) yearly.roic = roicY;
  }

  const result = {};
  if (Object.keys(quarterly).length) result.quarterly = quarterly;
  if (Object.keys(yearly).length) result.yearly = yearly;
  if (Object.keys(ttm).length) result.ttm = ttm;
  return Object.keys(result).length ? result : null;
}

async function main() {
  console.log('Fetching known foreign-filer list, sector-metrics feed, and SEC ticker->CIK map...');
  const [foreignFilerList, metricsDataset, tickerToCik, previouslyPublished] = await Promise.all([
    fetchJson(GIST_FOREIGN_FILER_LIST_URL).catch(() => null),
    fetchJson(GIST_METRICS_URL),
    fetchTickerToCikMap(),
    fetchPreviouslyPublished(),
  ]);

  let withCik;
  if (foreignFilerList?.foreignFilers?.length) {
    // Fast path: discoverForeignFilers.js (weekly) already did the
    // authoritative ifrs-full check across the full universe and published
    // the result — skip straight to extraction for that known list. This
    // is what actually cut the daily run's time down; see that script's
    // header for the full rationale, including why a STATIC/heuristic list
    // was previously rejected (a genuine IFRS filer whose Finnhub NATIVE
    // data happens to be populated, e.g. Scorpio Tankers/STNG, would never
    // get flagged as a "gap") — this list isn't heuristic, it's the same
    // real check, just run on a slower cadence than every day.
    withCik = foreignFilerList.foreignFilers;
    console.log(`Using the published foreign-filer list (generated ${foreignFilerList.generatedAt}): ${withCik.length} known foreign filers.`);
  } else {
    // Graceful bootstrap fallback — the discovery job hasn't published a
    // list yet (first-ever run, or a transient fetch failure). Falls back
    // to the original full-universe classification scan rather than
    // failing outright; every candidate is still checked via
    // processTicker's own authoritative ifrs-full gate below, so this is
    // slower but never wrong.
    console.log('No foreign-filer list available yet — falling back to a full-universe classification scan for this run.');
    const candidates = Object.entries(metricsDataset.metrics || {}).map(([symbol, data]) => ({ symbol, industry: data.industry }));
    withCik = candidates.map((c) => ({ ...c, cik: tickerToCik.get(c.symbol) })).filter((c) => c.cik);
    console.log(`${candidates.length} tickers in the covered universe; ${withCik.length} of those have a matching SEC CIK.`);
  }

  const trends = { ...previouslyPublished };
  let processed = 0;
  let resolved = 0;

  for (const { symbol, cik, industry } of withCik) {
    let fresh = null;
    try {
      fresh = await processTicker(symbol, cik, isFinancialIndustry(industry));
    } catch (err) {
      console.log(`  skip ${symbol}: ${err.message}`);
    }
    await sleep(REQUEST_SPACING_MS);

    const merged = pickCadenceTrendsToPublish(trends[symbol], fresh || {});
    if (Object.keys(merged).length) {
      trends[symbol] = merged;
      resolved++;
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
  dedupeInstantFacts,
  buildTrailingWindows,
  buildRatioTrend,
  buildQuarterlyRatioTrend,
  buildRevenueGrowthTrend,
  buildRevenueGrowthTTMTrend,
  buildAnnualRevenueGrowthTrend,
  buildAnnualRatioTrend,
  investedCapitalByEnd,
  buildRoicQuarterlyTrend,
  buildRoicYearlyTrend,
  buildRoicTTMTrend,
  migrateLegacyEntry,
  sanitizeCadencePoints,
  pickCadenceTrendsToPublish,
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
