// scripts/lib/businessQuantFallback.js
//
// Last-resort standalone-quarter fallback via the BusinessQuant fundamentals
// API (data.businessquant.com), used ONLY when a ticker's own SEC XBRL AND
// the 6-K filing-text fallback (extractFilingTextFacts.js) both leave a
// concept's quarterly series completely empty. Cross-validated live against
// EGO (a ticker with real, independently-verified 6-K-extracted quarterly
// data already in this pipeline) before integrating: revenue, netIncome,
// ocf, and capex all matched our own extracted values exactly (netIncome/
// ocf/capex to the dollar; revenue within BusinessQuant's own 2-sig-fig
// display rounding) for every overlapping quarter, including capex's sign
// convention (already negative/cash-outflow, same as ours - no flip needed).
//
// Despite that spot-check, this is a SINGLE external vendor's own
// normalization with no same-document or cross-filing corroboration
// available to us (unlike extractFilingTextFacts.js's Checks A/B/C) - a
// different, weaker trust model than the rest of this pipeline. The only
// guard applied here is reconcilePoints' existing Check B (full fiscal year
// vs. real annual XBRL, 2% tolerance) - a fiscal year only publishes if
// BusinessQuant's own quarters for that year sum to within 2% of a REAL
// annual figure we already have from SEC XBRL. A concept with no real
// annual anchor at all is never attempted, same policy as the 6-K fallback.
//
// A different revenue-statement structure can also cause BusinessQuant's
// "Revenue" line to map to a narrower concept than what this pipeline's own
// extractor picks (verified live: DEFT's multi-layer crypto-trading income
// statement has no BusinessQuant "Total Revenue" line and no matching
// quarter-end dates at all for the periods we needed) - Check B's real-
// annual-anchor requirement is what catches a concept mismatch like that
// (a wrong-concept quarter's sum won't reconcile to the real annual total),
// not a guarantee every ticker is coverable this way.

const { subtractThreeMonths, reconcilePoints, isAdjacentDate } = require('./extractFilingTextFacts');

const BQ_BASE = 'https://data.businessquant.com/statements';
const FETCH_TIMEOUT_MS = 30000;
// BusinessQuant's free tier is rate-limited to 50 requests/minute (per the
// docs) - 60000/50 = 1200ms is the bare minimum spacing to never exceed
// that; padded to 1300ms for safety margin. Applied AFTER every request
// (including the last one in a ticker's loop), so this also guarantees a
// minimum gap between the last request for one ticker and the first
// request for the next, regardless of how fast/slow the caller's own
// per-ticker work is.
const REQUEST_SLEEP_MS = 1300;

// One statement + section name per concept - verified live against EGO's
// real IS/CF statements. "Revenue (Quarter)" is a broad match (a company
// with its own multi-layer revenue breakdown may have additional, more
// specific sections BusinessQuant doesn't expose separately) - Check B's
// annual-anchor requirement is the guard against a mismatched concept here,
// not an attempt to disambiguate multiple candidates the way
// extractFilingTextFacts.js's Total-line preference does.
const CONCEPT_MAP = {
  revenue: { statement: 'IS', section: 'Revenue (Quarter)' },
  netIncome: { statement: 'IS', section: 'Consolidated Net Income (Quarter)' },
  ocf: { statement: 'CF', section: 'Cash from Operations (Quarter)' },
  capex: { statement: 'CF', section: 'Capital Expenditures (Quarter)' },
  // "basic" not diluted -- matches this whole pipeline's own established
  // preference for the shares concept elsewhere (resolveConceptCandidates
  // in extractFilingTextFacts.js).
  shares: { statement: 'IS', section: 'Shares Outstanding (Quarter)', nonAdditive: true },
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchStatement(ticker, statement, apiKey) {
  const url = `${BQ_BASE}?ticker=${encodeURIComponent(ticker)}&statement=${statement}&frequency=Quarter&period=all&api_key=${encodeURIComponent(apiKey)}`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) return null;
  const json = await res.json();
  if (json?.error || !json?.data) return null;
  return json;
}

function extractSectionPoints(json, sectionName) {
  if (!json?.data) return [];
  for (const category of Object.values(json.data)) {
    const section = category.sections?.[sectionName];
    if (!section) continue;
    return (section.values || [])
      .map((p) => ({ end: p.date, val: p.reportedValue?.raw }))
      .filter((p) => p.end && typeof p.val === 'number');
  }
  return [];
}

// Verification for NON-ADDITIVE concepts (shares outstanding), where Check
// B's sum-vs-annual reconciliation doesn't apply -- 4 quarterly share
// counts don't sum to anything meaningful, unlike revenue/ocf/capex.
// Instead: verify BusinessQuant's OWN value at every date where a real,
// independently-known ground-truth value already exists (from the filer's
// own real filings, at whatever cadence they actually disclose -- verified
// live for IMPP: BusinessQuant's own quarterly points at the filer's real
// H1/FY dates match its filed weighted-average-shares figures to the exact
// share, both basic and diluted, across every year checked). If every
// checkable point agrees, BusinessQuant's methodology is trusted for the
// WHOLE series -- including the interior quarters a filer like IMPP never
// discloses on its own, which have no ground truth to check against by
// definition. A single disagreement at any checkable point rejects the
// entire series for that ticker, rather than cherry-picking which points
// to trust. Requires at least one checkable point -- a ticker with zero
// real ground truth for this concept has nothing to establish trust from.
const GROUND_TRUTH_TOLERANCE = 0.01;

function verifyByGroundTruthMatch(points, groundTruthByEnd) {
  if (!groundTruthByEnd || !groundTruthByEnd.size) return [];
  const truths = [...groundTruthByEnd.values()];
  let checkedCount = 0;
  for (const p of points) {
    const match = truths.find((g) => isAdjacentDate(g.end, p.end));
    if (!match) continue;
    checkedCount++;
    const diff = Math.abs(p.val - match.value) / Math.abs(match.value);
    if (diff > GROUND_TRUTH_TOLERANCE) return []; // one disagreement -- distrust the whole series
  }
  if (!checkedCount) return [];
  return points;
}

/**
 * Fetches standalone-quarter facts for `neededConcepts` from BusinessQuant,
 * for a ticker whose own SEC XBRL and 6-K filing-text extraction both left
 * that concept's quarterly series empty. `annualByEnd` maps ISO end-date ->
 * a real ground-truth value per concept (same shape the 6-K fallback
 * already uses) - the required verification anchor; a concept with no real
 * ground-truth data is never attempted. For additive concepts (revenue/
 * netIncome/ocf/capex) this should be real ANNUAL XBRL facts only (Check
 * B's sum target). For "shares" (see CONCEPT_MAP's nonAdditive flag and
 * verifyByGroundTruthMatch above), the caller should pass EVERY real
 * disclosed value it has for this concept regardless of duration (annual
 * AND any real H1/cumulative facts) -- more real anchors means a stronger
 * trust basis, not a sum target.
 *
 * Returns { [concept]: Array<{start, end, val, filed}> }, same shape as
 * extractFactSeries/extractQuarterlyFactsFromFilings, ready to merge into
 * the caller's raw fact arrays before dedupeAndClassify runs.
 */
async function fetchBusinessQuantFacts(ticker, neededConcepts, annualByEnd, apiKey) {
  if (!apiKey) return {};
  const relevant = neededConcepts.filter((c) => CONCEPT_MAP[c] && annualByEnd?.[c]?.size);
  if (!relevant.length) return {};

  const statementsNeeded = new Set(relevant.map((c) => CONCEPT_MAP[c].statement));
  const statementJson = {};
  for (const statement of statementsNeeded) {
    try {
      statementJson[statement] = await fetchStatement(ticker, statement, apiKey);
    } catch {
      statementJson[statement] = null;
    }
    await sleep(REQUEST_SLEEP_MS);
  }

  const result = {};
  for (const concept of relevant) {
    const { statement, section } = CONCEPT_MAP[concept];
    const rawPoints = extractSectionPoints(statementJson[statement], section);
    if (!rawPoints.length) continue;

    const points = rawPoints
      .map((p) => {
        const start = subtractThreeMonths(p.end);
        return { start, end: p.end, val: p.val, filed: p.end };
      })
      // BusinessQuant's own history can include non-standard-length periods
      // (a stub quarter around a fiscal-year change, etc.) - only real
      // ~3-month periods are usable here, same day-count reasoning
      // dedupeAndClassify already applies to XBRL facts elsewhere.
      .filter((p) => {
        const days = (new Date(p.end) - new Date(p.start)) / (1000 * 60 * 60 * 24);
        return days >= 80 && days <= 100;
      });
    if (!points.length) continue;

    const verified = CONCEPT_MAP[concept].nonAdditive
      ? verifyByGroundTruthMatch(points, annualByEnd[concept])
      : reconcilePoints(points, annualByEnd[concept]);
    if (verified.length) {
      result[concept] = verified.map((p) => ({ start: p.start, end: p.end, val: p.val, filed: p.filed }));
    }
  }
  return result;
}

module.exports = { fetchBusinessQuantFacts };
