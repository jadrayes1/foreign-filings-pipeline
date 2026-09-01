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
const { extractQuarterlyFactsFromFilings, extractAnnualFactsFrom20F, throttleSecRequest, computeCumulativeFallbackConcepts } = require('./lib/extractFilingTextFacts');
const { fetchBusinessQuantFacts } = require('./lib/businessQuantFallback');

const OUTPUT_FILE = path.join(__dirname, '../foreignFilingsCache.json');
const GIST_METRICS_URL = 'https://gist.githubusercontent.com/jadrayes1/5cd7f459788725521246717b9e164a8e/raw/marketMetrics.json';
const GIST_FOREIGN_FILINGS_URL = 'https://gist.githubusercontent.com/jadrayes1/5cd7f459788725521246717b9e164a8e/raw/foreignFilingsCache.json';
// Published weekly by the separate discoverForeignFilers.js job/workflow —
// see that file's header for the full rationale. Read here so this DAILY
// job skips straight to extraction for a known list instead of re-deriving
// it from a full ~5,070-ticker classification scan every single day.
const GIST_FOREIGN_FILER_LIST_URL = 'https://gist.githubusercontent.com/jadrayes1/5cd7f459788725521246717b9e164a8e/raw/foreignFilerList.json';
const SEC_TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';
const SEC_COMPANYFACTS_BASE = 'https://data.sec.gov/api/xbrl/companyfacts';
// SEC's fair-use policy asks for a descriptive User-Agent identifying the
// requester and a real contact — this is NOT an API key, just good-citizen
// identification; see https://www.sec.gov/os/webmaster-faq#developers
const SEC_USER_AGENT = 'stock-analyzer-app foreign-filings-pipeline contact:jadrayescpp@gmail.com';
const QUARTERS_OF_HISTORY = 12; // mirrors src/utils/metrics.js

// A network interruption mid-request can leave a bare `fetch()` (no
// default timeout) hanging forever rather than erroring — verified live
// this session in the sibling smart-money-pipeline repo (a run stalled at
// 0% CPU for 5+ hours after an apparent connectivity blip). 30s is
// generous for any single SEC request; a real timeout surfaces as a
// normal caught error instead of an indefinite hang that could burn a
// scheduled workflow's entire timeout budget on one stuck ticker.
const FETCH_TIMEOUT_MS = 30000;

async function fetchJson(url) {
  // Shared with extractFilingTextFacts.js's own SEC requests — see that
  // file's own comment on throttleSecRequest for why this needs to be one
  // GLOBAL gate now that main() processes several tickers concurrently
  // (a worker pool), not per-call-site pacing. Harmless for this
  // function's one-time startup fetches (metrics feed, CIK map, etc.) —
  // only matters for the per-ticker companyfacts fetch inside
  // processTicker, which needs to share the same budget as everything
  // extractQuarterlyFactsFromFilings does for that same ticker.
  await throttleSecRequest();
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

// Each list below leads with the ifrs-full concept name(s) (what every
// foreign filer originally verified against this pipeline uses), followed
// by us-gaap equivalents -- extractFactSeries already searches BOTH
// taxonomies for whichever concept has real data (see its own comment), so
// simply adding the us-gaap names here is enough; no separate taxonomy-
// branching logic needed anywhere else. us-gaap names mirror the domestic
// pipeline's own SEC_REVENUE_CONCEPTS/NET_INCOME_CONCEPT_CANDIDATES/
// SEC_EBIT_CONCEPTS/OPERATING_SUBTOTAL_CONCEPTS/findReportedCapexQ in
// generateSectorMetrics.js -- added to cover genuine foreign private
// issuers that tag under us-gaap instead of ifrs-full (verified live:
// Ardmore Shipping/ASC, Teekay Tankers/TNK, Imperial Petroleum/IMPP all
// exclusively file 20-F/6-K, never 10-K/10-Q, despite using us-gaap -- see
// isGenuineForeignFiler below, which is what actually lets these through
// the gate; a domestic 10-K filer also has these us-gaap concepts but
// never reaches extraction because it fails that check first).
const REVENUE_CONCEPTS = [
  'Revenue',
  'Revenues',
  'RevenueFromContractWithCustomerExcludingAssessedTax',
  'RevenueFromContractWithCustomerIncludingAssessedTax',
  'SalesRevenueNet',
  'RevenuesNetOfInterestExpense',
];
const OCF_CONCEPTS = ['CashFlowsFromUsedInOperatingActivities', 'NetCashProvidedByUsedInOperatingActivities', 'NetCashProvidedByUsedInOperatingActivitiesContinuingOperations'];
const CAPEX_CONCEPTS = [
  'PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities',
  'PurchaseOfPropertyPlantAndEquipmentIntangibleAssetsOtherThanGoodwillInvestmentPropertyAndOtherNoncurrentAssets',
  'PaymentsToAcquirePropertyPlantAndEquipment',
  'PaymentsToAcquireProductiveAssets',
  'PaymentsForCapitalImprovements',
  'PaymentsToAcquireOtherPropertyPlantAndEquipment',
];
const NET_INCOME_CONCEPTS = ['ProfitLoss', 'NetIncomeLoss'];
const SHARES_CONCEPTS = ['WeightedAverageShares', 'WeightedAverageNumberOfSharesOutstandingBasic', 'WeightedAverageNumberOfDilutedSharesOutstanding'];

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
const EBIT_CONCEPTS = ['ProfitLossFromOperatingActivities', 'ProfitLossBeforeTax', 'OperatingIncomeLoss'];
// One fallback tier below EBIT_CONCEPTS -- for a filer that tags NONE of
// the 3 concepts above under ANY name, but does separately tag after-tax
// net income and income-tax expense with identical (start,end) period
// boundaries, pretax income (= netIncome + taxExpense) is real, standard
// arithmetic, not fabrication. Verified live: Toronto-Dominion Bank (TD)
// has zero facts under any of EBIT_CONCEPTS -- unlike its peer Canadian
// banks (RY/BNS/CM), which all tag ProfitLossBeforeTax directly -- but DOES
// have real, period-aligned ProfitLoss and IncomeTaxExpenseContinuing
// Operations facts for every fiscal year. us-gaap equivalent included for
// symmetry with EBIT_CONCEPTS' own ifrs-full/us-gaap mix, though only the
// ifrs-full one has a verified real-world case so far.
const TAX_EXPENSE_CONCEPTS = ['IncomeTaxExpenseContinuingOperations', 'IncomeTaxExpenseBenefit'];
// us-gaap equivalents added -- verified live this was the actual reason
// ROIC was at 99% empty (391/395) for the newly-classified us-gaap foreign
// filer population specifically: 'Equity'/'CashAndCashEquivalents'/
// 'Borrowings' are ifrs-full-only concept names, never valid under
// us-gaap, so XBRL-sourced invested capital was silently zero for that
// entire population even though revenue/netIncome/ebit/ocf/capex had
// already been fixed. Mirrors the domestic pipeline's own
// SEC_EQUITY_CONCEPTS/SEC_CASH_CONCEPTS/DEBT_CONCEPTS in
// generateSectorMetrics.js (battle-tested there across many real filers,
// including several "verified live" per-company surprises like CVS's
// combined debt+lease concept and Capital One's 3-way debt split).
const EQUITY_CONCEPTS = ['Equity', 'StockholdersEquity'];
const CASH_CONCEPTS = ['CashAndCashEquivalents', 'CashAndCashEquivalentsAtCarryingValue', 'CashAndCashEquivalentsAtFairValue', 'Cash'];
const DEBT_CONCEPTS = [
  'Borrowings',
  'LongtermBorrowings',
  'CurrentPortionOfLongtermBorrowings',
  'LongTermDebtNoncurrent',
  'LongTermDebtCurrent',
  'LongTermDebt',
  'ShortTermBorrowings',
  'CommercialPaper',
  'DebtCurrent',
  'SecuredDebtCurrent',
  'OtherLongTermDebtNoncurrent',
  'LongTermDebtAndCapitalLeaseObligationsCurrent',
  'LongTermDebtAndCapitalLeaseObligations',
  'SecuredDebt',
  'UnsecuredDebt',
  'OtherBorrowings',
];
const ROIC_ASSUMED_TAX_RATE = 0.21; // matches the main pipeline's own default simplification

// Searches ifrs-full first (what every foreign filer verified so far uses),
// then us-gaap as a defensive fallback in case a filer mixes taxonomies —
// returns the MERGED raw fact array (list of {start,end,val,filed,accn,
// form,fp,fy}) across every matching concept with real data, not just the
// first one found. conceptCandidates is a list of alternative XBRL tag
// names for the same real-world line item (never expected to represent
// two genuinely different amounts to be summed) -- merging rather than
// short-circuiting on the first match matters because a filer can (and
// does) switch which concept it tags the SAME line under across its
// filing history. Verified live: IMPP tagged its capex line as
// PaymentsToAcquirePropertyPlantAndEquipment in early 6-K filings (3
// sparse, H1-only facts) but PaymentsForCapitalImprovements in its actual
// 20-F annual reports back to 2020 (real annual data, current through
// FY2025) -- since the sparse concept came first in CAPEX_CONCEPTS and
// short-circuit-return stopped there, the rich annual data was never even
// looked at, even though every downstream consumer of this function
// already dedupes overlapping (start,end) periods by most-recently-filed
// (see dedupeAndClassify's byPeriod Map) -- exactly the mechanism needed
// to safely merge here too. Currency doesn't matter for the merge -- every
// ratio computed below is dimensionless or a self-relative percentage, so
// no cross-currency conversion is ever needed as long as a single
// company's own concepts share one currency, which they do.
function extractFactSeries(companyFacts, conceptCandidates) {
  const merged = [];
  for (const taxonomy of ['ifrs-full', 'us-gaap']) {
    const facts = companyFacts?.facts?.[taxonomy];
    if (!facts) continue;
    for (const concept of conceptCandidates) {
      const entry = facts[concept];
      if (!entry?.units) continue;
      for (const unitFacts of Object.values(entry.units)) {
        if (Array.isArray(unitFacts) && unitFacts.length) merged.push(...unitFacts);
      }
    }
  }
  return merged;
}

// Derives pretax income = netIncome + taxExpense for the SAME (start,end)
// period -- real arithmetic, not fabrication. Only meaningful when both
// concepts share identical period boundaries (verified live for TD: every
// ProfitLoss fact's (start,end) has a matching IncomeTaxExpenseContinuing
// Operations fact at the exact same (start,end)) -- a period mismatch
// between the two raw fact arrays just means no derived point for that
// period, never a guessed one. See TAX_EXPENSE_CONCEPTS' own comment for
// the motivating case.
function derivePretaxFromNetIncomeAndTax(netIncomeRaw, taxExpenseRaw) {
  const taxByPeriod = new Map();
  for (const f of taxExpenseRaw) {
    if (f.val == null || !f.start || !f.end) continue;
    taxByPeriod.set(`${f.start}|${f.end}`, f);
  }
  const derived = [];
  for (const ni of netIncomeRaw) {
    if (ni.val == null || !ni.start || !ni.end) continue;
    const tax = taxByPeriod.get(`${ni.start}|${ni.end}`);
    if (!tax) continue;
    derived.push({ start: ni.start, end: ni.end, val: ni.val + tax.val, filed: new Date(ni.filed) > new Date(tax.filed) ? ni.filed : tax.filed });
  }
  return derived;
}

function daysBetween(startStr, endStr) {
  const start = new Date(startStr);
  const end = new Date(endStr);
  return (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24);
}

function quarterLabelFromDate(dateStr) {
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return null;
  // Subtract a day before classifying -- a DERIVED quarter's end date is
  // sometimes computed as "the day the next quarter starts" (see
  // dedupeAndClassify's H1/annual decumulation), which can legitimately
  // fall on the 1st of the following month rather than the last day of
  // the quarter it actually closes out. Verified live: TNK's own Q2
  // duration starts "2017-04-01" per its own disclosed period boundary,
  // so a derived Q1 (H1 total minus known Q2) ends up dated the same
  // "2017-04-01" -- correct as a boundary, but a naive calendar-month
  // classification mislabels it "Q2 '17", colliding with the REAL Q2
  // anchor (which correctly ends June 30) under the identical label, and
  // silently doubling that quarter in any trend built from labels alone
  // (verified live in TTM revenue growth). No genuine accounting period
  // ends on the 1st of a month, so this adjustment can't misclassify any
  // real date -- every normal month-end (Mar 31, Jun 30, Sep 30, Dec 31)
  // shifts back one day and stays within the same quarter.
  const adjusted = new Date(d.getTime() - 24 * 60 * 60 * 1000);
  const q = Math.floor(adjusted.getUTCMonth() / 3) + 1;
  return `Q${q} '${String(adjusted.getUTCFullYear()).slice(-2)}`;
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
  // disagree on for the SAME real quarter: verified live, DHT's real XBRL
  // Q3 2024 fact discloses start=2024-07-01, while the same quarter
  // recovered via 6-K text extraction carries a SYNTHETIC start
  // (subtractThreeMonths(end), landing one day earlier at 2024-06-30) --
  // same end date, same value, genuinely the same quarter, but the exact
  // key treated them as two different periods, showing the same quarter
  // twice in published trends. Deduping by END DATE ALONE would be unsafe
  // done globally (an annual and a quarterly fact can legitimately share
  // an end date, e.g. both landing on a fiscal year-end) -- safe here
  // specifically because it's applied WITHIN each already-duration-
  // classified bucket, where every member has already passed the same
  // 80-100/170-200/260-300/350-380-day filter, so two points sharing an
  // end date inside one bucket are guaranteed to be the same real period.
  const dedupeByEnd = (points) => {
    const byEnd = new Map();
    for (const p of points) if (!byEnd.has(p.end)) byEnd.set(p.end, p);
    return Array.from(byEnd.values());
  };
  quarterly = dedupeByEnd(quarterly);
  h1 = dedupeByEnd(h1);
  q3ytd = dedupeByEnd(q3ytd);
  annual = dedupeByEnd(annual);

  const hasEnd = (end) => quarterly.some((q) => q.end === end);
  // Approximate (not exact-string) start match -- verified live this
  // matters: IMPP's real standalone Q1 2024 fact (from a text-extracted
  // 6-K) carries start=2023-12-31, while its real H1 2024 fact (a
  // DIFFERENT filing) carries start=2023-12-30 -- both synthesized via
  // subtractMonths from their own real end dates, landing one calendar day
  // apart purely from month-length arithmetic, despite representing the
  // exact same real fiscal-year start. An exact `Map.get(start)` lookup
  // never found the match, so H1-Q1 (and the same-shaped 9mo-H1/FY-9mo
  // derivations) silently never fired for IMPP at all -- not because the
  // data didn't exist, but because this lookup was too strict to find it.
  // Linear scan is fine -- these arrays hold at most a handful of points
  // per ticker.
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

// Derives a single missing standalone quarter as (real annual total - the 3
// other real standalone quarters within that same fiscal year), never
// fabrication — mirrors deriveMissingQuarterFromAnnual in the main pipeline's
// generateSectorMetrics.js, adapted to this file's date-keyed fact shape
// (start/end strings, not (year,quarter) integers) since fiscal year-ends
// aren't calendar-aligned for every filer.
//
// Verified live: STNG's own SEC data has real standalone Q1-Q3 revenue
// (surfaced via the 6-K filing-text fallback above, since XBRL itself only
// tags H1/FY periods for STNG) and a real annual total, but no discrete Q4 —
// foreign private issuers commonly report Q4 only as part of the annual
// filing, with no separate Q4 earnings release the 6-K fallback could ever
// find. This closes that exact gap with real arithmetic instead of leaving
// it permanently empty.
//
// Only derives when EXACTLY one quarter-sized gap exists within a fiscal
// year (3 known quarters tiling the year with a single contiguous hole,
// anywhere in the year, not just at the end) — a year with 2+ gaps has more
// unknowns than the one available equation (annual = sum of 4 quarters) can
// solve without guessing a split, so it's left alone.
function deriveMissingQuarterFromAnnual(quarterlyPoints, annualPoints) {
  const derived = [];
  for (const fy of annualPoints) {
    // Tolerant containment (via daysBetween, same ±5-day slop as isAdjacent
    // below), not exact string comparison — verified live: the 6-K
    // filing-text fallback's own extracted quarters routinely land a day
    // off a clean calendar boundary (e.g. start '2023-12-31' for what's
    // really "Q1 2024"), which a strict q.start >= fy.start check silently
    // excluded, undercounting withinYear and blocking derivation entirely.
    const withinYear = quarterlyPoints
      .filter((q) => daysBetween(fy.start, q.start) >= -5 && daysBetween(q.end, fy.end) >= -5)
      .sort((a, b) => new Date(a.start) - new Date(b.start));
    if (withinYear.length !== 3) continue;

    let cursor = fy.start;
    let gapStart = null;
    let gapEnd = null;
    let multipleGaps = false;
    for (const q of withinYear) {
      if (isAdjacent(cursor, q.start)) {
        cursor = q.end;
      } else if (gapStart == null) {
        gapStart = cursor;
        gapEnd = q.start;
        cursor = q.end;
      } else {
        multipleGaps = true;
        break;
      }
    }
    if (multipleGaps) continue;
    if (gapStart == null) {
      if (isAdjacent(cursor, fy.end)) continue; // no gap at all — 3 quarters can't fully tile a year on their own
      gapStart = cursor;
      gapEnd = fy.end;
    }

    // Sanity guard against a unit-scale mismatch between the annual XBRL
    // figure and 6-K-extracted quarters: reconcilePoints' Check A
    // (cumulative-column agreement) and Check C (cross-filing
    // corroboration) only validate a quarter's INTERNAL consistency with
    // other 6-K-disclosed numbers — only Check B cross-checks against the
    // real annual XBRL dollar scale, and a quarter can pass via A or C
    // alone. Verified live: STNG's own extracted quarters summed to
    // roughly 0.08% of its real annual revenue (a units mismatch, not 3
    // real quarters of a real year), which a naive subtraction would have
    // turned into a wildly wrong "derived Q4" using almost the ENTIRE
    // annual total. Three genuine quarters of a real fiscal year should
    // always be a substantial majority of that year's total, not a sliver
    // of it — reject anything implausible rather than derive from it.
    const sumKnown = withinYear.reduce((sum, q) => sum + q.value, 0);
    const ratio = fy.value !== 0 ? sumKnown / fy.value : null;
    if (ratio == null || ratio < 0.3 || ratio > 1.5) continue;
    derived.push({ start: gapStart, end: gapEnd, value: fy.value - sumKnown });
  }
  return derived;
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

// Raised from 10 (1000%) to 1000 (100,000%) after a real, verified case in
// the domestic pipeline (ASST/Strive's 2025 Bitcoin-treasury restructuring:
// net income losses jumped ~100x in magnitude while revenue stayed at a
// tiny pre-merger scale, producing a genuine, real ~-13,250% ratio,
// verified independently against SEC's own primary XBRL data — not a
// data-quality issue). The two examples that originally motivated this
// clamp (Denison Mines/DNN's FY'23 +4870%, Cardiol/CRDL's FY'21 -40,170%)
// are STILL both tiny/early-stage companies with a near-zero-denominator
// shape, and both now correctly show their real number at the new bound
// too, rather than being hidden as a "gap." The clamp's PURPOSE (catching
// a genuine extraction bug, e.g. a filer-side scale error) is preserved at
// this new, much wider bound — a real 1000x scale/decimal bug would still
// land in the millions of percent, still caught. Dropped (null) rather
// than published only beyond this new bound, same as any other
// uncomputable point. Same bound now used in generateSectorMetrics.js and
// src/utils/metrics.js in the main stock-analyzer/stock-metrics-pipeline
// repos — keep in sync.
const MAX_ABS_RATIO = 1000; // 100,000%
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

// A concept can have SOME standalone-quarter XBRL facts without being
// remotely current -- verified live: IAMGOLD/IAG tagged real interim
// facts for revenue/netIncome/ocf/capex only through Q4 2017, then
// switched to annual-only XBRL tagging, while its 6-K earnings releases
// keep filing real quarterly numbers right up to the present (verified:
// Q2 2026 revenue extractable from its own 6-K exhibit). The filing-text
// fallback below used to trigger only on a literal empty array, so a
// ticker in exactly this shape -- some quarterly facts, just 8 years
// stale -- permanently skipped it forever, even though the fallback can
// demonstrably pull fresh data for it. Mirrors the domestic pipeline's
// hasRecentQuarterlyGap fix for the same class of problem.
const QUARTERLY_STALE_GAP_DAYS = 550; // ~1.5 years -- generous filing-lag tolerance

// Genuinely different failure shape from the stale-tail check above --
// verified live: DHT Holdings' real SEC XBRL only ever tags a standalone
// Q3 duration directly (Jul 1 - Sep 30), with Q4 derived via
// annual-minus-9mo-YTD -- Q1/Q2 have no arithmetic path from what XBRL
// alone provides, so DHT's quarterly series stays genuinely CURRENT
// (reaches Q3'25/Q4'25) while permanently missing every Q1/Q2. The
// stale-tail check above never catches this -- the LAST point isn't
// stale at all -- so the fallback never even attempted DHT's real 6-K
// prose, which (same as IAG/STNG) plausibly has the missing standalone
// quarters even though XBRL doesn't tag them. Mirrors the domestic
// pipeline's hasRecentQuarterlyGap exactly (same constants, same
// position-based scan of the most recent N real points for a gap between
// CONSECUTIVE points, not just checking the tail against "now").
const RECENT_GAP_SCAN_ENTRIES = 16; // QUARTERS_OF_HISTORY (12) + margin
const EXPECTED_QUARTERLY_GAP_DAYS = 200;
function hasRecentQuarterlyGap(quarterlyPoints, scanEntries = RECENT_GAP_SCAN_ENTRIES) {
  const endDates = (quarterlyPoints || [])
    .map((p) => (p?.end ? new Date(p.end) : null))
    .filter((d) => d instanceof Date && !isNaN(d))
    .sort((a, b) => b - a); // newest first
  if (!endDates.length) return false; // nothing dated to check -- the empty-array trigger above already covers "no real data at all"
  const checkpoints = [new Date(), ...endDates.slice(0, scanEntries)];
  for (let i = 0; i < checkpoints.length - 1; i++) {
    const gapDays = (checkpoints[i] - checkpoints[i + 1]) / (1000 * 60 * 60 * 24);
    if (gapDays > EXPECTED_QUARTERLY_GAP_DAYS) return true;
  }
  return false;
}

function needsFilingTextBackfill(quarterlyPoints, annualPoints) {
  // Completely empty in BOTH cadences is unambiguously a backfill case, not
  // a "nothing to compare against" no-op -- verified live: ASC's capex has
  // zero XBRL data of any kind (no vessel-purchase concept exists in
  // CAPEX_CONCEPTS), so the very next check below (`!annualPoints.length`)
  // was silently concluding "nothing to backfill" and never even
  // attempting text-extraction for it, even though every quarter genuinely
  // needed it.
  if (!quarterlyPoints.length && !annualPoints.length) return true;
  if (!annualPoints.length) return false; // nothing to backfill against
  if (!quarterlyPoints.length) return true;
  const lastQuarterlyEnd = new Date(quarterlyPoints[quarterlyPoints.length - 1].end);
  const lastAnnualEnd = new Date(annualPoints[annualPoints.length - 1].end);
  if (lastAnnualEnd - lastQuarterlyEnd > QUARTERLY_STALE_GAP_DAYS * 24 * 60 * 60 * 1000) return true;
  return hasRecentQuarterlyGap(quarterlyPoints);
}

// 20-F annual-fallback trigger -- deliberately NOT needsFilingTextBackfill
// above, which checks whether QUARTERLY is stale RELATIVE TO annual (the
// right question for the 6-K fallback, which exists to recover quarterly
// data). The 20-F fallback exists to recover ANNUAL data specifically, and
// verified live this is a genuinely different failure shape: DHT's
// quarterly capex is already fresh (reaches the current quarter via the
// 6-K fallback above) while its ANNUAL capex specifically stays stuck at
// FY2021 (a company-specific custom XBRL extension tag switch -- see
// extractAnnualFactsFrom20F's own comment) -- needsFilingTextBackfill sees
// fresh quarterly data and never even notices annual is stale, since
// annual being OLDER than quarterly never trips its
// "annual much newer than quarterly" check. This checks annual's own
// staleness directly, independent of whatever quarterly looks like. Same
// threshold/shape as needsInstantBackfill just below.
function needsAnnual20FBackfill(annualPoints) {
  if (!annualPoints.length) return true;
  const lastAnnualEnd = new Date(annualPoints[annualPoints.length - 1].end);
  return Date.now() - lastAnnualEnd.getTime() > QUARTERLY_STALE_GAP_DAYS * 24 * 60 * 60 * 1000;
}

// Instant-fact (equity/debt/cash) counterpart -- no annual anchor to
// compare against (an instant snapshot has no "cumulative" concept the way
// a flow does), so this just checks whether the most recent real point is
// itself stale relative to now. Same threshold as the flow-concept check
// for consistency, generous enough to tolerate a filer that only discloses
// its balance sheet semi-annually (verified live: STNG only shows a
// balance sheet alongside its H1/FY earnings releases, not every quarter)
// without misfiring on that as "stale".
function needsInstantBackfill(instantPoints) {
  if (!instantPoints.length) return true;
  const lastEnd = new Date(instantPoints[instantPoints.length - 1].end);
  return Date.now() - lastEnd.getTime() > QUARTERLY_STALE_GAP_DAYS * 24 * 60 * 60 * 1000;
}

// Returns { quarterly, yearly, ttm }, each an object keyed by
// revenueGrowth/profitMargin/fcfMargin (only the ones with enough
// underlying data to compute) — each cadence stands on its own, computed
// independently from the same already-fetched facts, rather than the old
// single "best" series picked by a preferQuarterly flag. A filer like
// IAMGOLD/IAG (stale 2016-17 quarterly XBRL facts, current annual facts
// all the way to FY'25) used to just end up with a real `yearly` entry
// and empty `quarterly`/`ttm` ones — turned out NOT to be an inherent
// data limitation (see needsFilingTextBackfill above): IAG's own 6-K
// exhibits have real quarterly numbers right up to the present, the
// fallback just never used to trigger for a ticker with SOME (if
// ancient) quarterly facts already present.
// A domestic US-GAAP filer's SEC companyfacts ALSO has real us-gaap data
// (every US public company files US-GAAP XBRL with SEC, foreign or not),
// so having us-gaap facts alone can't be the signal — otherwise
// extractFactSeries would happily reconstruct trends for literally every
// SEC-registered company, duplicating what stock-metrics-pipeline already
// does via Finnhub. The real signal is the FORM TYPES a filer actually
// submits: a genuine foreign private issuer files 20-F/40-F (annual) +
// 6-K (interim/current) and never 10-K/10-Q, regardless of which XBRL
// taxonomy it happens to tag under. Verified live: Ardmore Shipping/ASC,
// Teekay Tankers/TNK, and Imperial Petroleum/IMPP are all genuine 20-F/6-K
// filers using us-gaap (not ifrs-full) -- discoverForeignFilers.js's
// original ifrs-full-only check missed this whole population entirely,
// so these tickers got no data from either pipeline: not from here (failed
// the ifrs-full gate) and not fully from stock-metrics-pipeline (Finnhub's
// financials-reported endpoint doesn't crawl 20-F/6-K forms either).
// Scans the SAME companyFacts payload already fetched here -- no extra
// request needed.
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

// True for either a genuine ifrs-full filer (the original, narrower check)
// OR a genuine us-gaap-taxonomy foreign private issuer (see
// isGenuineForeignFormFiler above). Kept in sync with the identically-named
// check in discoverForeignFilers.js.
function isGenuineForeignFiler(companyFacts) {
  if (companyFacts?.facts?.['ifrs-full'] && Object.keys(companyFacts.facts['ifrs-full']).length) return true;
  if (companyFacts?.facts?.['us-gaap'] && Object.keys(companyFacts.facts['us-gaap']).length && isGenuineForeignFormFiler(companyFacts)) return true;
  return false;
}

async function processTicker(symbol, cik, isBank) {
  const companyFacts = await fetchJson(`${SEC_COMPANYFACTS_BASE}/CIK${cik}.json`);
  if (!companyFacts) return null;

  // See isGenuineForeignFiler's own comment for the full rationale —
  // checked here (before any concept extraction) rather than via a
  // candidate-list prefilter in main() — see that function's own comment
  // for why card-value nullness turned out to be the wrong signal
  // (verified live: Scorpio Tankers/STNG is a genuine IFRS filer whose
  // Finnhub NATIVE data happens to be fully populated, so it was never
  // flagged as a "gap" ticker despite having zero Quarterly/Yearly
  // reconstruction available from either pipeline).
  if (!isGenuineForeignFiler(companyFacts)) return null;

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
  let ebit = dedupeAndClassify(ebitRaw);
  // TD-style fallback: a filer with ZERO facts under any EBIT_CONCEPTS name
  // (not just stale/sparse -- see TAX_EXPENSE_CONCEPTS' own comment) gets
  // one more real, non-fabricated tier: pretax income derived from its
  // separately-tagged net income and tax expense. Placed before the
  // ENABLE_FILING_TEXT_FALLBACK block below so needsFilingTextBackfill sees
  // the improved state and doesn't waste a redundant 6-K-text pretaxIncome
  // request for a ticker this already fixes via pure arithmetic.
  // Unconditional (no flag) since it costs zero extra network calls --
  // companyFacts is already fetched.
  if (!ebitRaw.length) {
    const taxExpenseRaw = extractFactSeries(companyFacts, TAX_EXPENSE_CONCEPTS);
    const derivedPretax = derivePretaxFromNetIncomeAndTax(netIncomeRaw, taxExpenseRaw);
    if (derivedPretax.length) ebit = dedupeAndClassify(derivedPretax);
  }
  // Computed early (moved ahead of dedupeInstantFacts's original call site
  // further below) so the filing-text fallback right below can use these
  // as reconciliation anchors (reconcileInstantPoints' direct-date-match
  // check) BEFORE any text-extracted facts get merged in — re-run after
  // merging, same pattern the flow concepts already use.
  let equityInstant = dedupeInstantFacts(equityRaw);
  let cashInstant = dedupeInstantFacts(cashRaw);
  let debtInstant = dedupeInstantFacts(debtRaw);

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
  // Declared here (not inside the block below) so the 20-F fallback further
  // down -- which needs to layer its own recovered facts on top of the
  // ORIGINAL XBRL raw arrays (revenueRaw etc.) PLUS whatever this 6-K pass
  // already recovered, never on top of already-classified .quarterly/
  // .annual points, which dedupeAndClassify can't re-consume (different
  // shape: {value}, not {val,filed}) -- can see what this pass found.
  let filingTextFacts = {};
  if (process.env.ENABLE_FILING_TEXT_FALLBACK) {
    const allowlist = process.env.FILING_TEXT_FALLBACK_TICKERS
      ? new Set(process.env.FILING_TEXT_FALLBACK_TICKERS.split(',').map((s) => s.trim().toUpperCase()))
      : null;
    if (!allowlist || allowlist.has(symbol.toUpperCase())) {
      const needed = [];
      if (needsFilingTextBackfill(revenue.quarterly, revenue.annual)) needed.push('revenue');
      if (needsFilingTextBackfill(netIncome.quarterly, netIncome.annual)) needed.push('netIncome');
      // pretaxIncome requested WHENEVER ebit is, not just when ebit's own
      // extraction fails -- verified live: Ardmore Shipping (ASC) has no
      // "operating income" line in its income statement at all (nets
      // interest/gains-on-sale in before its only pre-net-income subtotal,
      // "Income before taxes and equity method investments"), so the ebit
      // pattern would always come back empty for this filer, every run,
      // if only attempted after already failing. Requesting both up front
      // costs nothing extra -- same filings already being scanned either way.
      const ebitNeeded = needsFilingTextBackfill(ebit.quarterly, ebit.annual);
      if (ebitNeeded) needed.push('ebit', 'pretaxIncome');
      if (needsFilingTextBackfill(ocf.quarterly, ocf.annual)) needed.push('ocf');
      if (needsFilingTextBackfill(capex.quarterly, capex.annual)) needed.push('capex');

      // Balance-sheet (equity/debt/cash) concepts don't have their own
      // quarterly/annual split to run needsFilingTextBackfill against (an
      // instant snapshot isn't "quarterly" or "annual", just a date) —
      // originally just reused the flow concepts' own verdict as the
      // trigger, on the theory that a ticker needing revenue/netIncome/
      // ocf/capex from 6-K text almost always has the same gap for its
      // balance sheet too. Verified live this ISN'T always true: ASC's
      // revenue/profitMargin are already fresh straight from XBRL (never
      // trigger the flow-concept fallback at all), while its equity/debt/
      // cash XBRL genuinely stops around 2019 -- different concepts,
      // different real coverage, so piggybacking on the flow verdict alone
      // left ROIC stuck stale even for a ticker with otherwise-current
      // data. Now ALSO triggers independently whenever the balance-sheet
      // data's own most recent point is stale, on top of (not instead of)
      // the original free-ride case.
      const balanceSheetStale = needsInstantBackfill(equityInstant) || needsInstantBackfill(debtInstant) || needsInstantBackfill(cashInstant);
      if (needed.length || balanceSheetStale) needed.push('equity', 'debt', 'cash');

      if (needed.length) {
        const annualByEnd = {
          revenue: new Map(revenue.annual.map((a) => [a.end, a])),
          netIncome: new Map(netIncome.annual.map((a) => [a.end, a])),
          ebit: new Map(ebit.annual.map((a) => [a.end, a])),
          // Reuses ebit's own annual map as pretaxIncome's reconciliation
          // anchor too -- extractFactSeries's EBIT_CONCEPTS list already
          // tries ProfitLossBeforeTax as a fallback when a filer has no
          // operating-income XBRL concept at all, so ebit.annual is ALREADY
          // pretax-income-sourced for exactly the filers (like ASC) that
          // need this quarterly fallback -- the right anchor either way.
          pretaxIncome: new Map(ebit.annual.map((a) => [a.end, a])),
          ocf: new Map(ocf.annual.map((a) => [a.end, a])),
          capex: new Map(capex.annual.map((a) => [a.end, a])),
          // Not actually "annual" for these three — reconcileInstantPoints
          // treats this as a direct same-date-match anchor (any real XBRL
          // instant fact, not specifically a fiscal year-end one), reusing
          // the same annualByEnd plumbing rather than adding a parallel
          // parameter.
          equity: new Map(equityInstant.map((e) => [e.end, e])),
          debt: new Map(debtInstant.map((e) => [e.end, e])),
          cash: new Map(cashInstant.map((e) => [e.end, e])),
        };
        // Per-ticker, per-concept -- see computeCumulativeFallbackConcepts'
        // own comment for why this can't be a static list. pretaxIncome
        // reuses ebitRaw's own non-annual-duration check, same reasoning
        // as annualByEnd above reusing ebit.annual as its anchor.
        const cumulativeFallbackConcepts = computeCumulativeFallbackConcepts({
          revenue: revenueRaw,
          netIncome: netIncomeRaw,
          ebit: ebitRaw,
          pretaxIncome: ebitRaw,
          ocf: ocfRaw,
          capex: capexRaw,
        });
        try {
          filingTextFacts = await extractQuarterlyFactsFromFilings(cik, needed, annualByEnd, SEC_USER_AGENT, cumulativeFallbackConcepts);
        } catch (err) {
          console.warn(`  filing-text fallback failed for ${symbol}: ${err.message}`);
        }
        if (filingTextFacts.revenue?.length) revenue = dedupeAndClassify([...revenueRaw, ...filingTextFacts.revenue]);
        if (filingTextFacts.netIncome?.length) netIncome = dedupeAndClassify([...netIncomeRaw, ...filingTextFacts.netIncome]);
        if (filingTextFacts.ebit?.length) ebit = dedupeAndClassify([...ebitRaw, ...filingTextFacts.ebit]);
        // Only reached when the filer has no operating-income line at all
        // (verified live: ASC) -- ebit's own text extraction above will
        // have found nothing to merge, so this is the sole source for it.
        if (ebitNeeded && needsFilingTextBackfill(ebit.quarterly, ebit.annual) && filingTextFacts.pretaxIncome?.length) {
          ebit = dedupeAndClassify([...ebitRaw, ...filingTextFacts.pretaxIncome]);
        }
        if (filingTextFacts.ocf?.length) ocf = dedupeAndClassify([...ocfRaw, ...filingTextFacts.ocf]);
        // XBRL's capex concept is a positive magnitude (verified live:
        // IAG's FY2025 capex = 293,500,000) but the press-release table
        // reports it parenthesized/negative (a cash outflow) — negated
        // here to match XBRL's sign convention before merging, since
        // downstream fcfMargin math (ocf.value - capex.value) assumes it.
        if (filingTextFacts.capex?.length) {
          capex = dedupeAndClassify([...capexRaw, ...filingTextFacts.capex.map((f) => ({ ...f, val: -f.val }))]);
        }
        if (filingTextFacts.equity?.length) equityInstant = dedupeInstantFacts([...equityRaw, ...filingTextFacts.equity]);
        if (filingTextFacts.debt?.length) debtInstant = dedupeInstantFacts([...debtRaw, ...filingTextFacts.debt]);
        if (filingTextFacts.cash?.length) cashInstant = dedupeInstantFacts([...cashRaw, ...filingTextFacts.cash]);
      }
    }
  }

  // 20-F annual-report fallback -- fills a genuinely different gap than the
  // 6-K fallback above: a filer whose 20-F switched a concept to a
  // company-specific custom XBRL extension tag (verified live: DHT's
  // `dht:InvestmentsInVessels`), which SEC's structured companyfacts API
  // never exposes under any standard taxonomy name, no matter how many
  // concept-list alternatives are added -- only parsing the 20-F document
  // itself recovers it. Re-checks needsFilingTextBackfill AFTER the 6-K
  // merge above (not the pre-merge state) so a concept the 6-K pass already
  // fixed doesn't pay for a redundant, heavier 20-F scan (3 full documents'
  // FilingSummary.xml + several R-files each, vs. the 6-K path's lighter
  // per-filing cost). Own flag/allowlist, separate from
  // ENABLE_FILING_TEXT_FALLBACK -- same rollout discipline as
  // ENABLE_BUSINESSQUANT_FALLBACK below, staged via workflow_dispatch
  // against a small ticker set first given the added per-ticker cost.
  if (process.env.ENABLE_20F_ANNUAL_FALLBACK) {
    const allowlist = process.env.FILING_TEXT_FALLBACK_TICKERS
      ? new Set(process.env.FILING_TEXT_FALLBACK_TICKERS.split(',').map((s) => s.trim().toUpperCase()))
      : null;
    if (!allowlist || allowlist.has(symbol.toUpperCase())) {
      const needed20F = [];
      if (needsAnnual20FBackfill(revenue.annual)) needed20F.push('revenue');
      if (needsAnnual20FBackfill(netIncome.annual)) needed20F.push('netIncome');
      if (needsAnnual20FBackfill(ebit.annual)) needed20F.push('ebit', 'pretaxIncome');
      if (needsAnnual20FBackfill(ocf.annual)) needed20F.push('ocf');
      if (needsAnnual20FBackfill(capex.annual)) needed20F.push('capex');
      const balanceSheetStale20F = needsInstantBackfill(equityInstant) || needsInstantBackfill(debtInstant) || needsInstantBackfill(cashInstant);
      if (needed20F.length || balanceSheetStale20F) needed20F.push('equity', 'debt', 'cash');

      if (needed20F.length) {
        const annualByEnd20F = {
          revenue: new Map(revenue.annual.map((a) => [a.end, a])),
          netIncome: new Map(netIncome.annual.map((a) => [a.end, a])),
          ebit: new Map(ebit.annual.map((a) => [a.end, a])),
          pretaxIncome: new Map(ebit.annual.map((a) => [a.end, a])),
          ocf: new Map(ocf.annual.map((a) => [a.end, a])),
          capex: new Map(capex.annual.map((a) => [a.end, a])),
          equity: new Map(equityInstant.map((e) => [e.end, e])),
          debt: new Map(debtInstant.map((e) => [e.end, e])),
          cash: new Map(cashInstant.map((e) => [e.end, e])),
        };
        let annual20FFacts = {};
        try {
          annual20FFacts = await extractAnnualFactsFrom20F(cik, needed20F, annualByEnd20F, SEC_USER_AGENT);
        } catch (err) {
          console.warn(`  20-F annual fallback failed for ${symbol}: ${err.message}`);
        }
        // Layered on top of the ORIGINAL XBRL raw arrays (revenueRaw etc.)
        // plus whatever the 6-K pass above already recovered (filingTextFacts,
        // hoisted to this function's scope for exactly this) -- NOT on top
        // of revenue.quarterly/.annual, which are already-classified
        // {value}-shaped points dedupeAndClassify can't re-consume (it
        // expects raw {val,filed}-shaped facts). Same merge shape the 6-K
        // block above already uses.
        if (annual20FFacts.revenue?.length) revenue = dedupeAndClassify([...revenueRaw, ...(filingTextFacts.revenue || []), ...annual20FFacts.revenue]);
        if (annual20FFacts.netIncome?.length) netIncome = dedupeAndClassify([...netIncomeRaw, ...(filingTextFacts.netIncome || []), ...annual20FFacts.netIncome]);
        if (annual20FFacts.ebit?.length) ebit = dedupeAndClassify([...ebitRaw, ...(filingTextFacts.ebit || []), ...annual20FFacts.ebit]);
        if (needsAnnual20FBackfill(ebit.annual) && annual20FFacts.pretaxIncome?.length) {
          ebit = dedupeAndClassify([...ebitRaw, ...(filingTextFacts.ebit || []), ...annual20FFacts.pretaxIncome]);
        }
        if (annual20FFacts.ocf?.length) ocf = dedupeAndClassify([...ocfRaw, ...(filingTextFacts.ocf || []), ...annual20FFacts.ocf]);
        // Same sign flip as the 6-K path above -- a 20-F table's own
        // parenthesized value is a negative outflow, same convention as
        // the 6-K exhibit's, but XBRL's capex concept is a positive
        // magnitude; downstream fcfMargin math (ocf.value - capex.value)
        // assumes XBRL's convention.
        if (annual20FFacts.capex?.length) {
          capex = dedupeAndClassify([...capexRaw, ...(filingTextFacts.capex || []), ...annual20FFacts.capex.map((f) => ({ ...f, val: -f.val }))]);
        }
        if (annual20FFacts.equity?.length) equityInstant = dedupeInstantFacts([...equityRaw, ...(filingTextFacts.equity || []), ...annual20FFacts.equity]);
        if (annual20FFacts.debt?.length) debtInstant = dedupeInstantFacts([...debtRaw, ...(filingTextFacts.debt || []), ...annual20FFacts.debt]);
        if (annual20FFacts.cash?.length) cashInstant = dedupeInstantFacts([...cashRaw, ...(filingTextFacts.cash || []), ...annual20FFacts.cash]);
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
      if (needsFilingTextBackfill(revenue.quarterly, revenue.annual)) stillNeeded.push('revenue');
      if (needsFilingTextBackfill(netIncome.quarterly, netIncome.annual)) stillNeeded.push('netIncome');
      if (needsFilingTextBackfill(ocf.quarterly, ocf.annual)) stillNeeded.push('ocf');
      if (needsFilingTextBackfill(capex.quarterly, capex.annual)) stillNeeded.push('capex');

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

  // Cross-cadence derivation — fills a single missing standalone quarter
  // from (real annual total - the 3 other real standalone quarters), never
  // fabrication. Runs after both fallbacks above so it can use whatever
  // real quarters they surfaced (e.g. STNG's Q1-Q3 revenue, only available
  // via the 6-K fallback since XBRL itself has no standalone-quarter facts
  // for it at all — see deriveMissingQuarterFromAnnual's own comment).
  // Flow concepts only (revenue/netIncome/ebit/ocf/capex) — equity/cash/debt
  // below are point-in-time balance-sheet snapshots, not additive across
  // quarters, same scope boundary the main pipeline's ROIC derivation
  // draws in generateSectorMetrics.js.
  for (const flow of [revenue, netIncome, ebit, ocf, capex]) {
    const derivedQuarters = deriveMissingQuarterFromAnnual(flow.quarterly, flow.annual);
    if (derivedQuarters.length) {
      flow.quarterly = [...flow.quarterly, ...derivedQuarters].sort((a, b) => new Date(a.start) - new Date(b.start));
    }
  }

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

  // Verified live: a full run can hit a rare Node/undici runtime bug
  // (`assert(!this.paused)` in undici's H1 client, thrown from inside
  // Node's own socket/parser event handling when a fetch is aborted right
  // as its response is being read — undici issue, not this file's own
  // logic) as an UNCAUGHT exception outside the try/catch below entirely,
  // since it fires asynchronously from a callback the awaited
  // processTicker() call has already returned from by the time it throws.
  // A run that hit this after successfully processing 350/374 tickers over
  // ~6.5 hours lost all of it, because `trends` only ever got written to
  // disk ONCE, at the very end of the loop. globalStop lets the loop exit
  // cleanly and still write/return whatever WAS collected instead of
  // crashing the whole process — scoped narrowly (only set by this one
  // handler, only checked here), so an ordinary per-ticker error (already
  // handled by the try/catch immediately below) never trips it.
  let globalStop = null;
  const onUncaught = (err) => {
    console.error(`  Uncaught exception mid-run (likely a transient Node/undici bug, not this script's own logic) — stopping further processing and writing what's collected so far: ${err.message}`);
    globalStop = err;
  };
  process.on('uncaughtException', onUncaught);

  // Bounded-concurrency worker pool (real per-ticker timing from a
  // completed run showed a consistent ~40-49s/ticker cost, dominated by
  // many SERIALIZED SEC requests per ticker with zero overlap between any
  // two waits — the old fully-sequential loop plus per-call-site
  // sleep(150)s). Pacing is now centralized in throttleSecRequest
  // (extractFilingTextFacts.js) as a global token-bucket gate on request
  // STARTS, so N workers issuing requests concurrently still can't jointly
  // exceed SEC's ~10 req/sec fair-use guidance — each worker's requests
  // just interleave through the same shared gate instead of each worker
  // keeping its own independent pacing. This is what actually lets
  // concurrency help: workers overlap their WAITING time, not just their
  // request-issuing time. 4 chosen per user direction (moderate) — no
  // fixed per-ticker sleep is needed any more since the real pacing now
  // happens per-request, centrally.
  const CONCURRENCY = 4;
  let nextIndex = 0;

  async function worker() {
    while (!globalStop) {
      const i = nextIndex++;
      if (i >= withCik.length) return;
      const { symbol, cik, industry } = withCik[i];
      let fresh = null;
      try {
        fresh = await processTicker(symbol, cik, isFinancialIndustry(industry));
      } catch (err) {
        console.log(`  skip ${symbol}: ${err.message}`);
      }
      if (globalStop) return;

      const merged = pickCadenceTrendsToPublish(trends[symbol], fresh || {});
      if (Object.keys(merged).length) {
        trends[symbol] = merged;
        resolved++;
      }

      processed++;
      if (processed % 50 === 0) console.log(`  ${processed}/${withCik.length} processed (${resolved} resolved so far)`);
    }
  }

  try {
    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  } finally {
    process.off('uncaughtException', onUncaught);
  }

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify({ generatedAt: new Date().toISOString(), trends }));
  const stoppedEarly = globalStop ? ` (stopped early after an uncaught exception: ${globalStop.message})` : '';
  console.log(`Done. Processed ${processed}/${withCik.length} tickers, ${resolved} resolved to at least one trend${stoppedEarly}. Cache now covers ${Object.keys(trends).length} tickers total.`);
}

module.exports = {
  extractFactSeries,
  dedupeAndClassify,
  dedupeInstantFacts,
  isGenuineForeignFiler,
  isGenuineForeignFormFiler,
  needsFilingTextBackfill,
  needsAnnual20FBackfill,
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
  deriveMissingQuarterFromAnnual,
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
