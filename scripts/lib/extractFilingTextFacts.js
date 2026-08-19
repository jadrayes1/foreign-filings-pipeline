// scripts/lib/extractFilingTextFacts.js
//
// Fallback quarterly-data source for foreign filers whose SEC XBRL has zero
// standalone-quarter facts (only H1/9mo/annual) — verified live for ~252 of
// 356 currently-published tickers (foreign private issuers are exempt from
// 10-Q filing, so no quarterly XBRL exists for these companies from ANY
// vendor sourcing SEC's structured API, including Finnhub). The real
// standalone-quarter numbers DO exist for free, though: SEC 6-K filings
// (furnished instead of 10-Q) routinely include a real earnings statement
// as an exhibit — just as free HTML/text, not tagged XBRL. Verified live
// for two structurally different filers:
//   - STNG (Scorpio Tankers): 6-K furnishes ONE exhibit, a press release,
//     with a "Condensed Consolidated Statements of Income" HTML <table>
//     showing "Three months ended <date>" / "Six months ended <date>"
//     columns. No balance sheet.
//   - IAG (IAMGOLD): 6-K furnishes MULTIPLE exhibits, including a full,
//     formal "Condensed Consolidated Interim Financial Statements" document
//     with a real Balance Sheet, Income Statement, AND Cash Flow Statement,
//     same column structure.
//
// Used STRICTLY as a fallback — the caller (generateForeignFilingsCache.js)
// only invokes this for a ticker/concept whose real XBRL-derived quarterly
// data is confirmed empty, never to compete with or override data that
// already works. See the plan file (cosmic-sparking-bubble.md, "6-K
// filing-text extraction") for the full design rationale, including a
// design review that surfaced the specific risks guarded against below
// (fact.val not fact.value; column matching by explicit end-date, not
// ordinal position; footnote-reference numbers masquerading as data
// columns; permutation-blind reconciliation).
//
// Returns facts in the exact shape extractFactSeries produces
// ({start, end, val, filed}) so callers can merge them straight into the
// same raw arrays dedupeAndClassify already consumes — no separate
// fallback layer, every existing downstream sanity check (classification,
// de-cumulation, clampImplausible, merge-protection) applies unmodified.

const cheerio = require('cheerio');

const SEC_SUBMISSIONS_BASE = 'https://data.sec.gov/submissions';
const SEC_ARCHIVES_BASE = 'https://www.sec.gov/Archives/edgar/data';
const MAX_FILINGS_TO_SCAN = 25; // ~2 years of quarters for a normal quarterly filer
// High-frequency filers (DEFT, CMBT and others verified live: 90+ 6-Ks/year,
// mostly routine press releases/NAV updates) blow through MAX_FILINGS_TO_SCAN
// within a few months when just taking the N most recent 6-Ks regardless of
// size - the prior-year comparative filing (needed for cross-filing
// corroboration, see Check C below) falls completely outside the window.
// submissions.json already carries each filing's total byte size for free
// (no extra fetch) - a real earnings-release 6-K is verified live to be
// well above a routine one's size, though the exact gap varies by filer
// (DEFT's real Q1 2026 exhibit-bearing filing: 2,578,754 bytes vs.
// 27,019-47,261 bytes for its routine filings the same month; CMBT's real
// Q1 2026 filing: 409,230 bytes vs. a 149,098-byte routine-filing ceiling)
// - so filtering by size before counting against MAX_FILINGS_TO_SCAN lets
// the same fetch budget reach much further back in time by skipping the
// routine noise entirely. Set comfortably below the smaller real filer
// (CMBT) while still well above every filer's routine-filing ceiling seen
// so far.
const MIN_SUBSTANTIVE_FILING_BYTES = 200000;
const FILING_LOOKBACK_ENTRIES = 400; // how far into submissions.json's 'recent' list to look for size-qualifying candidates
const MIN_EXHIBIT_BYTES = 20000; // cover-page heuristic — verified live: STNG's 6-K cover page was 11,450 bytes, its real earnings exhibit 733,171 bytes
const RECONCILE_TOLERANCE = 0.02; // 2%

// "Earnings" as an income-statement synonym verified live: CNQ titles its
// real income statement "CONSOLIDATED STATEMENTS OF EARNINGS" (distinct
// from its separate "...OF COMPREHENSIVE INCOME" table, which only carries
// OCI reconciliation items — no revenue line at all. Matching both is safe
// since extractStatement already tries every heading match in a document
// in order and moves on if a match yields no line-item hits.
// Tolerant of CONDENSED/INTERIM/UNAUDITED inserted between CONSOLIDATED and
// the statement phrase (in any combination/order) - verified live: Baytex
// (BTE) titles its real cash-flow statement "Condensed Consolidated
// Interim Statements of Cash Flows", where "Interim" sits between
// "Consolidated" and "Statements" and broke the old rigid adjacency
// requirement. Words BEFORE "Consolidated" (e.g. GFR's "Condensed Interim
// Consolidated...") already matched fine since the regex isn't anchored.
// "Statements of Profit or Loss (and Other Comprehensive Income/Loss)" —
// verified live: GDTC and FGL (both IFRS filers) title their real income
// statement this way, a standard IFRS convention distinct from the
// US-GAAP-style "Statement of Operations/Income/Earnings" phrasings below.
// Neither company's income statement was found at all without this.
const STATEMENT_HEADINGS = {
  income: /CONSOLIDATED\s+(?:CONDENSED\s+|INTERIM\s+|UNAUDITED\s+)*(STATEMENTS? OF (COMPREHENSIVE )?INCOME|STATEMENTS? OF OPERATIONS|STATEMENTS? OF EARNINGS|INCOME STATEMENTS?|STATEMENTS? OF PROFIT OR LOSS)/i,
  // "FLOWS?" (trailing S optional) -- verified live: DHT's cash-flow
  // statement is headed "CONSOLIDATED\nSTATEMENT OF CASH FLOW (UNAUDITED)",
  // genuinely singular throughout ("Statement", not "Statements"; "Flow",
  // not "Flows"). "STATEMENTS?" already tolerated the singular/plural
  // difference for the first word -- inconsistent that "FLOWS" was left
  // mandatory-plural right next to it. hasCashflow was false for every one
  // of DHT's real documents as a result, so capex/ocf extraction never
  // even attempted to run for this filer.
  cashflow: /CONSOLIDATED\s+(?:CONDENSED\s+|INTERIM\s+|UNAUDITED\s+)*STATEMENTS? OF CASH ?FLOWS?/i,
  // Not anchored on "CONSOLIDATED" needing to be the very first word — same
  // reasoning as income/cashflow above (the regex isn't `^`-anchored, so
  // "Condensed Consolidated Balance Sheets" still matches via the
  // "Consolidated Balance Sheets" substring). Verified live: STNG uses
  // "Condensed Consolidated Balance Sheets", IAG uses plain "Consolidated
  // Balance Sheets" with no extra qualifiers.
  balanceSheet: /CONSOLIDATED\s+(?:CONDENSED\s+|INTERIM\s+|UNAUDITED\s+)*(BALANCE SHEETS?|STATEMENTS? OF FINANCIAL POSITION)/i,
};

// A real statement title is always short - verified live this matters:
// Baytex's MD&A exhibit has multi-thousand-character prose paragraphs that
// happen to mention "consolidated statements of cash flows" deep inside
// running narrative text (e.g. a footnote about an accounting-standard
// change), and with no length check the heading-search below would treat
// the ENTIRE paragraph as "the heading" and grab whatever table follows it
// - almost never the real statement. A genuine title comfortably fits
// under this even with "(Unaudited)"/currency suffixes.
const MAX_HEADING_TEXT_LENGTH = 200;

// Text-label matching, per concept: a broad INCLUDE keyword pattern plus an
// EXCLUDE pattern that disqualifies an otherwise-matching row. Chosen over
// a growing list of hand-anchored per-filer regexes (the original shape
// here, which needed a fresh tweak almost every time a new filer's exact
// wording showed up — "Revenues from mining operations" (AEM), "Oil sales,
// net of royalties" (GFR), "Petroleum and natural gas sales" (BTE), etc.)
// — a broad keyword net catches unforeseen wording automatically, and the
// exclude list generalizes across filers too (a real statement's sibling
// sub-lines follow a small, recurring set of patterns — "per share",
// "attributable to non-controlling interests", "from discontinued
// operations" — regardless of which company or industry is filing).
// Still deliberately conservative: the caller (extractFromTable) drops a
// concept as AMBIGUOUS the moment 2+ rows in the same table match, so a
// keyword net that's slightly too wide fails safe (nothing published)
// rather than guessing between candidates.
const LABEL_ALIASES = {
  revenue: {
    include: /revenues?\b|\bsales\b/i,
    // "gain on" excluded - verified live: STNG (a tanker company) has a
    // real income-statement line "Gain on sales of vessels" (an asset-
    // disposal gain, unrelated to operating revenue) that matched the
    // broad \bsales\b keyword and conflicted with the real "Vessel
    // revenue" line's different value, dropping revenue entirely via the
    // AMBIGUOUS guard. Any company that periodically disposes of assets
    // (ships, mines, real estate, equipment) can have this exact same
    // "Gain on sale(s) of X" phrasing - not specific to STNG.
    exclude: /cost of|growth|per share|marketing|deferred|unearned|allowance|\btax\b|discontinued|forecast|guidance|gain on/i,
  },
  netIncome: {
    include: /net (income|earnings|loss)\b|\bprofit \(loss\)\b|\bprofit for the (period|year)\b/i,
    exclude: /shares?\b|attributable to (non|minority)|from (continuing|discontinued)|margin|growth|\bbefore\b/i,
  },
  // ROIC's numerator (mirrors EBIT_CONCEPTS in generateForeignFilingsCache.js
  // -- ProfitLossFromOperatingActivities/ProfitLossBeforeTax). Verified
  // live: STNG labels this "Operating income", IAG "Earnings from
  // operations" -- both single, unambiguous lines on the SAME income
  // statement table revenue/netIncome are extracted from.
  // "loss" added as an alternative to "income/profit/earnings" throughout
  // -- verified live: Cango Inc (CANG) labels this line "Loss from
  // operations" in a quarter where it actually lost money at the
  // operating level, not "Income from operations". Mirrors netIncome's
  // own pattern just above, which already handles this exact case
  // (net (income|earnings|loss)) -- ebit/pretaxIncome were added later and
  // missed replicating it, very likely the single largest reason a broad
  // full-universe scan found ROIC still empty for the majority of foreign
  // filers even after every other fix this session: ANY company that's
  // ever reported an operating loss in the periods being scanned hits
  // this, not just an unlucky few.
  ebit: {
    include: /operating (income|profit|earnings|loss)|(income|profit|earnings|loss) from operations/i,
    // "^other\b" added -- verified live: IMPP's income statement has a real
    // sub-component line, "Other operating income" (a piece that rolls
    // UP INTO the real "Income from operations" subtotal, not the subtotal
    // itself), which also matches "operating income" via this rule's own
    // first alternative. Both labels lack a "Total" prefix, so the
    // ambiguity tiebreak below can't resolve it either -- previously
    // harmless only because "Other operating income"'s row had a cell-count
    // mismatch (split-parenthesis formatting, see nonEmptyCells) that made
    // it unparseable and silently dropped; fixing that formatting quirk
    // elsewhere ironically made this row parseable too, turning a
    // previously-unambiguous match into a real conflict that suppressed
    // ebit entirely for this filer. A real operating-income SUBTOTAL is
    // never itself prefixed "Other" in standard accounting presentation.
    exclude: /per share|margin|growth|^other\b/i,
  },
  // Fallback for a filer with no operating-income subtotal at all --
  // verified live: Ardmore Shipping (ASC) nets interest/gains-on-sale in
  // BEFORE its only pre-net-income subtotal, "Income before taxes and
  // equity method investments" -- mirrors EBIT_CONCEPTS' own
  // ProfitLossBeforeTax fallback on the XBRL side (same reasoning: some
  // filers, notably banks, don't report a genuine operating-income line
  // at all). Deliberately a SEPARATE concept from ebit rather than folded
  // into the same include pattern -- a filer that reports BOTH lines
  // (the common case) would otherwise match twice and get dropped as
  // ambiguous; the caller only requests this when ebit itself came back
  // empty, giving the same "operating income first, pre-tax as backup"
  // tier the XBRL concept list already has.
  //
  // Tolerant of a "(loss)" parenthetical inserted between "income" and
  // "before tax" -- verified live: CANG labels this exact line "Net
  // income (loss) before income taxes", the same dual-framing convention
  // netIncome's own "profit \(loss\)" pattern already accounts for.
  pretaxIncome: {
    include: /(income|profit|earnings)\s*(\(loss\))?\s*before (income )?tax|pre-?tax (income|loss)/i,
    exclude: /per share|margin|growth/i,
  },
  ocf: {
    // "inflow"/"outflow" added -- verified live: Scorpio Tankers (STNG,
    // Marshall Islands-domiciled) labels this line "Net cash inflow from
    // operating activities" (IFRS/shipping-industry phrasing), not the
    // US-GAAP "provided by"/"used in" wording this pattern originally
    // covered -- didn't match at all, so OCF (and by extension fcfMargin,
    // which needs it) silently found nothing for a filer whose real cash
    // flow statement was sitting right there. Likely not STNG-specific;
    // "inflow"/"outflow" is standard IFRS statement-of-cash-flows wording.
    include: /cash (flows? )?(from|provided by|generated (from|by)|used in|inflow|outflow).*operating/i,
    exclude: /investing|financing|discontinued/i,
  },
  capex: {
    // "acquisition(s) of vessels"/"drydock" added -- verified live: STNG
    // (a tanker company) has no line labeled anything like "capital
    // expenditures" at all; its two real capex-equivalent lines are
    // "Acquisition of vessels and payments for vessels under
    // construction" and "Drydock and other vessel related payments" (see
    // the capex-specific summing tiebreak above, which combines the two).
    // "of property" tolerates ONE inserted qualifier word before "property"
    // -- verified live: AAUC (a gold miner) labels this line "Purchase of
    // mineral property, plant and equipment", which the original
    // "purchase(s)? of property" (no gap allowed) never matched. Capex came
    // back completely empty for AAUC as a result, dragging fcfMargin down
    // with it even though revenue/ebit extraction were both fine --
    // confirmed this is a distinct root cause from ROIC's reconciliation
    // gap, not the same bug wearing a different mask.
    // "acquisition(s)? of property" added alongside "acquisition(s)? of
    // vessels" -- verified live: NYAX's real, investing-section capex line
    // is "Acquisition of property and equipment", which neither the
    // vessel-specific nor the purchase-specific alternative matched. Only
    // a smaller, unrelated supplemental line ("Purchase of property and
    // equipment on credit") was matching before, silently understating
    // capex (and therefore fcfMargin) for this filer.
    // "investment(s)? in vessels/property" added -- verified live: DHT (a
    // tanker company like STNG, but a different real-terms phrasing) has
    // "Investment in vessels", "Investment in vessels under construction",
    // and "Investment in other property, plant and equipment" as its real
    // investing-section capex lines -- a THIRD distinct real-world phrasing
    // for the same underlying concept, none of "acquisition of"/"purchase
    // of"/"capital expenditures" covering it.
    include: /capital expenditures?|purchase(s)? of( \w+)? property|acquisition(s)? of( \w+)? property|investments? in( \w+)? (vessels?|property)|additions to (property|oil and gas|exploration)|acquisition(s)? of vessels|drydock/i,
    exclude: /proceeds|disposal|\bsale of\b/i,
  },
  // Balance-sheet (instant, not duration) concepts — see
  // extractFromInstantTable/parseInstantTableColumns below. Mirrors
  // EQUITY_CONCEPTS/DEBT_CONCEPTS/CASH_CONCEPTS' scope in
  // generateForeignFilingsCache.js (the XBRL-sourced equivalents) so a
  // text-extracted instant fact means the same thing as an XBRL one when
  // the two get merged.
  equity: {
    // Verified live: STNG labels this "Total shareholders' equity" —
    // matches the existing totalMatches tiebreak automatically (starts
    // with "Total"). IAG's own grand-total equity row, by contrast, has NO
    // text label at all (a bare subtotal row after "Non-controlling
    // interests") — a known, accepted gap, not something this pattern can
    // reach; see the module header notes.
    include: /total (shareholders|stockholders)('|s)? equity|total equity/i,
    exclude: /per share/i,
  },
  debt: {
    // Verified live: both STNG and IAG split debt into two real balance-
    // sheet lines — "Current portion of long-term debt" and "Long-term
    // debt" — neither a subtotal of the other. Summed via the same
    // capex-style tiebreak below (extended to cover debt too).
    include: /long-?term debt|borrowings?|loans? payable|notes payable/i,
    exclude: /proceeds|repayment|issuance/i,
  },
  cash: {
    include: /cash and cash equivalents/i,
    // Verified live: IAG's balance sheet has a SEPARATE "Restricted cash"
    // line under non-current assets — a real, different asset, not part of
    // the readily-available cash ROIC's invested-capital formula wants
    // (mirrors investedCapitalByEnd's own XBRL-sourced CASH_CONCEPTS
    // scope, which also excludes restricted cash).
    exclude: /restricted/i,
  },
};

function matchesConcept(label, concept) {
  const rule = LABEL_ALIASES[concept];
  if (!rule) return false;
  return rule.include.test(label) && !rule.exclude.test(label);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A network interruption mid-request (verified live in this session, in
// the sibling smart-money-pipeline repo: a run stalled at 0% CPU for 5+
// hours after an apparent connectivity blip, with no error and no
// progress — plain `fetch()` has no default timeout, so a connection that
// drops without a clean close/error just hangs forever) needs an explicit
// ceiling. 30s is generous for any single SEC request.
const FETCH_TIMEOUT_MS = 30000;

// Shared, process-wide gate every SEC request funnels through — both from
// this file's own extraction loop AND generateForeignFilingsCache.js's own
// companyfacts fetch (which imports throttleSecRequest for exactly this).
// Replaces the old model of per-call-site `sleep(150)` calls that only
// paced ONE sequential chain of requests: main() now processes several
// tickers CONCURRENTLY (a worker pool, not one-ticker-at-a-time), so
// pacing needs to cap the AGGREGATE rate across every ticker in flight at
// once, not just each ticker's own chain independently — otherwise N
// concurrent tickers each pacing at 150ms would jointly hit N times SEC's
// intended rate.
//
// Verified live this was the real bottleneck, not SEC's own response
// latency: the OLD fully-sequential design (one ticker, one request at a
// time, await-then-sleep) averaged ~40-49s/ticker across a real 350-ticker
// run — with up to 25 filings scanned per ticker and several sequential
// requests per filing for tickers whose 6-Ks aren't Inline-XBRL-tagged
// (the exhibit-scan fallback path), that's dozens of round-trips per
// ticker, NONE of them ever overlapped with another's wait time.
//
// Token-bucket style: gates on when a request STARTS, not when the
// previous one FINISHES — this is what actually allows multiple requests
// to be in flight simultaneously (a slow response from one ticker's
// request no longer blocks a totally independent one), while still
// enforcing a safe minimum spacing between request starts.
const MIN_REQUEST_INTERVAL_MS = 150; // ~6.7 req/sec aggregate — comfortable margin under SEC's ~10 req/sec fair-use guidance
let requestChain = Promise.resolve();
let lastRequestStartedAt = 0;

function throttleSecRequest() {
  const turn = requestChain.then(async () => {
    const wait = Math.max(0, lastRequestStartedAt + MIN_REQUEST_INTERVAL_MS - Date.now());
    if (wait > 0) await sleep(wait);
    lastRequestStartedAt = Date.now();
  });
  // Chain the NEXT request's wait on this one regardless of whether this
  // one throws later (it won't — this only ever resolves), so one slow
  // link can never wedge the whole queue.
  requestChain = turn.catch(() => {});
  return turn;
}

async function fetchWithTimeout(url, options) {
  await throttleSecRequest();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url, userAgent) {
  const res = await fetchWithTimeout(url, { headers: { 'User-Agent': userAgent } });
  if (!res.ok) return null;
  return res.text();
}

async function fetchJsonSec(url, userAgent) {
  const res = await fetchWithTimeout(url, { headers: { 'User-Agent': userAgent, Accept: 'application/json' } });
  if (!res.ok) return null;
  return res.json();
}

// "408,734" / "$408,734" / "(64,827)" (negative) / "—" or "-" (blank = 0).
// Returns null for genuinely non-numeric text (a label, not a value).
function parseNumericCell(text) {
  const t = text.trim();
  if (t === '' || /^[-—–]$/.test(t)) return 0;
  const negative = /^\(.*\)$/.test(t);
  const cleaned = t.replace(/[()$,\s]/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  const num = parseFloat(cleaned);
  return negative ? -num : num;
}

// Tolerant of a trailing restatement annotation - verified live: Baytex
// (BTE) labels its prior-year comparative columns "2025 Revised (1)" (a
// footnote marker for a post-close restatement), which an exact whole-cell
// match silently drops as "not a year cell" at all, collapsing the header
// row down to only its current-year columns and losing every comparative
// period. The negative lookahead still rejects a longer, unrelated number
// like "20259" (not followed by a non-digit), so this only ever matches a
// real 4-digit year at the start of the cell.
function isYearCell(text) {
  return /^(19|20)\d{2}(?!\d)/.test(text.trim());
}

// isYearCell only gates the match; callers need just the 4-digit year, not
// "2025 Revised (1)" wholesale (that string would never equal a plain
// "2025" in the downstream year === targetEndYear comparisons).
function extractYear(text) {
  const m = text.trim().match(/^((?:19|20)\d{2})(?!\d)/);
  return m ? m[1] : text.trim();
}

function nonEmptyCells($, row) {
  const cells = $(row)
    .find('td,th')
    .toArray()
    .map((c) => ({ text: $(c).text().replace(/\s+/g, ' ').trim(), colspan: parseInt($(c).attr('colspan') || '1', 10) }))
    .filter((c) => c.text.length > 0);
  // Merge a lone ")" cell into the immediately preceding one -- verified
  // live: CANG's Q4/full-year release renders a negative value's closing
  // parenthesis in its own separate <td> ("(688,395" then ")" as two
  // adjacent cells, presumably for right-alignment), which otherwise
  // inflates the row's cell count past columns.length and makes every
  // loss-reporting row in the table unparseable (a same-table row with only
  // positive values, with no parenthesis to split, is unaffected -- verified
  // live too). A cell whose ENTIRE text is just ")" is never meaningful
  // data on its own, so merging it is safe regardless of what precedes it.
  const merged = [];
  for (const c of cells) {
    if (c.text === ')' && merged.length) {
      merged[merged.length - 1] = { ...merged[merged.length - 1], text: merged[merged.length - 1].text + ')' };
    } else {
      merged.push(c);
    }
  }
  return merged;
}

// "For the three months ended June 30," -> {months: 3, endMonthDay: 'June 30'}
// A period-length phrase doesn't always carry its own date inline though —
// verified live: CNQ's period row just says "Three Months Ended"/"Six
// Months Ended" with the date living in the NEXT row's cells instead (see
// parseDateHeaderCell below) — endMonthDay is null in that case, filled in
// from the date row instead.
// Shared with the phraseCells gate below (parseTableColumns) so the two
// can't drift out of sync -- verified live this happened once already:
// Imperial Petroleum (IMPP) titles its standalone-quarter column "Quarters
// Ended March 31," instead of "Three Months Ended March 31," (same
// meaning, different wording). Fixing parsePeriodPhrase alone wasn't
// enough the first time -- the OUTER gate that decides whether to even
// call it also only recognized literal "month(s) ended", silently
// discarding this row before parsePeriodPhrase ever ran.
// "years? ended" added -- verified live: CANG's Q4/full-year combined
// earnings release headers its two column groups "For three months ended
// December 31" and "For the years ended" side by side (4 date cells: 3mo-
// 2024, 3mo-2025, FY-2024, FY-2025). Without this, the annual phrase cell
// didn't match at all and was silently dropped from periodPhrases, leaving
// only the 3-month phrase to cover all 4 date cells -- the even-
// distribution math in parseTableColumns then mislabeled the two real
// full-year columns as 3-month too, corrupting every concept extracted
// from this table shape (a near-universal one: any foreign filer's Q4
// release plausibly has both a quarter and a full-year column together).
const PERIOD_PHRASE_INDICATOR = /months? ended|quarters? ended|years? ended/i;

function parsePeriodPhrase(text) {
  const months = /nine months|9 months/i.test(text)
    ? 9
    : /six months|6 months/i.test(text)
      ? 6
      : /three months|3 months|quarters? ended/i.test(text)
        ? 3
        : /twelve months|12 months|years? ended/i.test(text)
          ? 12
          : null;
  if (!months) return null;
  const dateMatch = text.match(/ended\s+([A-Za-z]+\s+\d{1,2})/i);
  return { months, endMonthDay: dateMatch ? dateMatch[1] : null };
}

// A header's "date row" cell is either a bare 4-digit year (STNG/IAG style
// — the day/month already came from the period row's own "ended <date>"
// phrase) or a compound "<Month> <Day><Year>" cell (CNQ style — verified
// live: "Jun 302026", no space between day and year, likely two adjacent
// inline elements with no text node between them in the source HTML).
// Returns null for neither shape, so a genuinely unrelated cell (e.g. a
// stray "Notes" or "(In millions...)" label) is correctly ignored.
function parseDateHeaderCell(text) {
  if (isYearCell(text)) return { year: extractYear(text), monthDay: null };
  // CANG's balance sheet (and presumably other filers') labels each date
  // column "As of December 31, 2024" rather than a bare date -- strip the
  // prefix before the anchored date match rather than loosening the date
  // match itself, so this can't accidentally start matching non-date cells.
  const stripped = text.replace(/^as\s+(of|at)\s+/i, '').trim();
  const compound = stripped.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s*((?:19|20)\d{2})$/);
  if (compound) return { year: compound[3], monthDay: `${compound[1]} ${compound[2]}` };
  return null;
}

// Combines the period-length header row with the date header row by COUNT
// (not raw colspan-grid position) — verified live this is necessary: real
// filers' header rows have different leading non-date cell counts (STNG:
// one "In thousands..." label cell before the dates; IAG: TWO, "(In
// millions...)" AND "Notes"), which breaks naive colspan-position alignment
// between the two rows even though both rows sum to the same total grid
// width in neither case. Instead: take the ordered list of distinct period
// phrases from the period row, take ONLY the actual date-ish cells from
// the date row (ignoring "Notes"/label artifacts entirely), and distribute
// the period phrases evenly across the date cells in order — holds across
// every real format seen so far (2 period phrases x 2 years each = 4 date
// cells, in "3mo-2026, 3mo-2025, 6mo-2026, 6mo-2025" order every time).
function parseBareMonthDayCell(text) {
  const m = text.trim().match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?$/);
  return m ? `${m[1]} ${m[2]}` : null;
}

const MONTH_ABBR_INDEX = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

// "Jan. 1 - Mar. 31, 2026" -> 3 (a whole-quarter span). Buckets the actual
// day gap between the two dates to the nearest of 3/6/9 months rather than
// assuming a fiscal-quarter-aligned start, with the same generous tolerance
// used everywhere else in this file for date-ish matching.
function monthSpanToQuarterMonths(startMonth, startDay, endMonth, endDay, year) {
  const si = MONTH_ABBR_INDEX[startMonth.slice(0, 3).toLowerCase()];
  const ei = MONTH_ABBR_INDEX[endMonth.slice(0, 3).toLowerCase()];
  if (si == null || ei == null) return null;
  const days = (Date.UTC(Number(year), ei, Number(endDay)) - Date.UTC(Number(year), si, Number(startDay))) / (1000 * 60 * 60 * 24);
  if (Math.abs(days - 90) <= 10) return 3;
  if (Math.abs(days - 181) <= 10) return 6;
  if (Math.abs(days - 273) <= 10) return 9;
  return null;
}

function parseTableColumns($, table) {
  const rows = $(table).find('tr').toArray();
  let periodPhrases = null;
  // A FOURTH header shape, verified live: Eldorado Gold (EGO) splits the
  // date across its OWN separate row - a bare "June 30," with no year at
  // all - sitting between the period-length row ("Three months ended")
  // and a further row with just bare years ("2026 2025 2026 2025").
  // Neither existing shape captures this (parseDateHeaderCell's compound
  // match requires the year in the SAME cell as the month/day; a bare
  // year cell alone carries no month/day of its own). Captured here, one
  // entry per PERIOD PHRASE (mirroring how `phrase.endMonthDay` already
  // pairs 1:1 with periodPhrases, not with the later, more numerous date
  // cells), and merged in below once the bare-year row is reached.
  let pendingMonthDays = null;
  for (let i = 0; i < rows.length; i++) {
    const cells = nonEmptyCells($, rows[i]);

    // Single-row header, verified live for BCE: "For the period ended
    // March 31 (in millions...) (unaudited) | Note | 2026 | 2025" — the
    // period phrase and the year cells share one row, and there's no
    // "three/six months" qualifier at all since a Q1 report has nothing
    // to compare a standalone quarter against yet. A bare "period ended"
    // with no explicit month count is only trustworthy as a 3-month
    // figure when it's the ONLY phrase in the table (no competing 6mo/9mo
    // column) — genuinely true for Q1, since a first quarter's own "period
    // ended" figure IS the standalone quarter by fiscal-calendar
    // definition, not an assumption specific to this filer.
    if (!periodPhrases) {
      const bareDateCell = cells.find((c) => /(periods?|quarters?) ended\s+[A-Za-z]+\s+\d{1,2}/i.test(c.text) && !/months? ended/i.test(c.text));
      if (bareDateCell) {
        const dateMatch = bareDateCell.text.match(/ended\s+([A-Za-z]+\s+\d{1,2})/i);
        const yearCellsInSameRow = cells.filter((c) => isYearCell(c.text)).map((c) => extractYear(c.text));
        if (dateMatch && yearCellsInSameRow.length >= 2) {
          const columns = yearCellsInSameRow.map((year) => ({ months: 3, endMonthDay: dateMatch[1], year }));
          return { columns, dataStartRowIdx: i + 1 };
        }
      }
    }

    // A SIXTH header shape, verified live: Eldorado Gold's (EGO) own Q1
    // filing has no comparative 6mo column at all (nothing to compare a
    // first quarter against yet — same reasoning as the BCE case just
    // above), and rather than splitting period/date/year across separate
    // cells or rows, each column is fully self-contained in ONE cell:
    // "Three months ended March 31, 2026". Checked before the
    // "months? ended" phrase-only match just below, which would otherwise
    // partially match this same text and treat it as a period-phrase-only
    // row with no year anywhere to combine it with.
    if (!periodPhrases) {
      const fullDateCells = cells
        .map((c) => {
          const m = c.text.match(/^(three|six|nine)\s+months?\s+ended\s+([A-Za-z]+\s+\d{1,2}),?\s*((?:19|20)\d{2})$/i);
          if (!m) return null;
          const months = { three: 3, six: 6, nine: 9 }[m[1].toLowerCase()];
          return { months, endMonthDay: m[2], year: m[3] };
        })
        .filter(Boolean);
      if (fullDateCells.length >= 1) {
        return { columns: fullDateCells, dataStartRowIdx: i + 1 };
      }
    }

    // A SEVENTH header shape, verified live: CMBT states each column as an
    // explicit date RANGE rather than a "months ended" phrase at all -
    // "Jan. 1 - Mar. 31, 2026" / "Jan. 1 - Mar. 31, 2025" - fully self-
    // contained per cell, with a separate bare-year row above it that's
    // purely decorative (the year already lives inside the range itself).
    if (!periodPhrases) {
      const dateRangeCells = cells
        .map((c) => {
          const m = c.text.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2})\s*-\s*([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s*((?:19|20)\d{2})$/);
          if (!m) return null;
          const months = monthSpanToQuarterMonths(m[1], m[2], m[3], m[4], m[5]);
          return months ? { months, endMonthDay: `${m[3]} ${m[4]}`, year: m[5] } : null;
        })
        .filter(Boolean);
      if (dateRangeCells.length >= 1) {
        return { columns: dateRangeCells, dataStartRowIdx: i + 1 };
      }
    }

    if (!periodPhrases) {
      const phraseCells = cells.filter((c) => PERIOD_PHRASE_INDICATOR.test(c.text));
      if (phraseCells.length) {
        const parsed = phraseCells.map((c) => parsePeriodPhrase(c.text)).filter(Boolean);
        // A "years ended"/"twelve months ended" phrase in a Q4+FY combined
        // table often doesn't repeat its own end date -- verified live:
        // CANG's "For the years ended" carries no date at all, unlike its
        // sibling "For three months ended December 31" in the same header
        // row. The fiscal year-end IS the same date as the quarter it's
        // paired with by definition, so backfill a missing endMonthDay from
        // any sibling phrase that has one, rather than rejecting every
        // column in the row for a date every phrase already implies.
        const knownEndMonthDay = parsed.find((p) => p.endMonthDay)?.endMonthDay;
        if (knownEndMonthDay) for (const p of parsed) if (!p.endMonthDay) p.endMonthDay = knownEndMonthDay;
        if (parsed.length) periodPhrases = parsed;
      }
      continue;
    }
    if (!pendingMonthDays) {
      const monthDayCells = cells.map((c) => parseBareMonthDayCell(c.text)).filter(Boolean);
      if (monthDayCells.length === periodPhrases.length) {
        pendingMonthDays = monthDayCells;
        continue;
      }
    }

    const dateCells = cells.map((c) => parseDateHeaderCell(c.text)).filter(Boolean);
    if (dateCells.length >= 2) {
      if (dateCells.length % periodPhrases.length !== 0) continue; // malformed — try a later row rather than guess
      const yearsPerPeriod = dateCells.length / periodPhrases.length;
      const columns = dateCells.map((date, idx) => {
        const phrase = periodPhrases[Math.floor(idx / yearsPerPeriod)];
        const pendingMonthDay = pendingMonthDays ? pendingMonthDays[Math.floor(idx / yearsPerPeriod)] : null;
        const endMonthDay = date.monthDay || pendingMonthDay || phrase.endMonthDay;
        return endMonthDay ? { months: phrase.months, endMonthDay, year: date.year } : null;
      });
      if (columns.some((c) => !c)) continue; // neither row carries a date for some column — bail on this row, try the next
      return { columns, dataStartRowIdx: i + 1 };
    }
  }
  return null;
}

// Splits a data row's non-empty cells into {label, values}. A row is only
// treated as a real data line if it resolves to EXACTLY columns.length
// numeric values — a section header (e.g. "Revenue", "Operating expenses")
// has zero, and is correctly skipped rather than mismatched.
//
// Handles one concrete wrinkle verified live in IAG's cash-flow statement:
// a footnote-reference number (e.g. "21") sits between the label and the
// real values on rows with a note citation, colspan-matching the "Notes"
// header column. Distinguished from a real value by shape, not position —
// footnote refs are always bare 1-3 digit integers (no decimal point, no
// comma), while every real value in the same statement carries a decimal
// point or comma. Dropped only when doing so makes the count match exactly
// and at least one other value in the row has a decimal/comma (confirming
// this statement's own value formatting) — never guessed otherwise.
function parseDataRow(cells, columnCount) {
  let labelParts = [];
  let i = 0;
  while (i < cells.length && cells[i].text !== '$' && parseNumericCell(cells[i].text) === null) {
    labelParts.push(cells[i].text);
    i++;
  }
  if (!labelParts.length) return null;
  const valueCandidates = [];
  for (; i < cells.length; i++) {
    if (cells[i].text === '$') continue;
    const val = parseNumericCell(cells[i].text);
    if (val === null) return null; // non-numeric cell after values started — malformed, bail
    valueCandidates.push({ raw: cells[i].text, val });
  }
  let values = valueCandidates;
  if (values.length === columnCount + 1) {
    const [first, ...rest] = values;
    const looksLikeFootnoteRef = /^\d{1,3}$/.test(first.raw.trim());
    const restHaveDecimalOrComma = rest.some((v) => /[.,]/.test(v.raw));
    if (looksLikeFootnoteRef && restHaveDecimalOrComma) values = rest;
  }
  if (values.length !== columnCount) return null;
  return { label: labelParts.join(' '), values: values.map((v) => v.val) };
}

// Parses a single already-located <table> for the target quarter's line
// items — shared by both discovery paths: extractStatement (heading-search,
// for press-release/formal-statement documents) and extractFromRFile
// (FilingSummary.xml-directed, for SEC's auto-rendered Inline XBRL viewer
// fragments — see extractFromRFile's own comment for why that path never
// needs a heading search at all). Returns both the TARGET 3-month column's
// value per concept AND, when present, that same row's own 6-month/9-month
// column value for the SAME fiscal year (used for within-filing
// reconciliation by the caller — no separate lookup needed since it's the
// same row, just a different column).

// Concepts that should only ever match a row within a SPECIFIC cash-flow-
// statement section -- see extractFromTable's section-tracking comment for
// why this exists. Concepts not listed here are unrestricted, matching
// anywhere in the table exactly as before.
const SECTION_RESTRICTED_CONCEPTS = { capex: 'investing' };

// Concepts for which a cumulative-only (H1/9mo) column is an acceptable
// substitute for a missing 3-month one -- see the usingCumulativeOnly
// fallback below. Deliberately NOT extended to income-statement concepts
// (revenue/netIncome/ebit/pretaxIncome) -- verified live this caused a
// real regression for IMPP, whose XBRL already carries real H1-duration
// facts for these concepts that dedupeAndClassify already knows how to
// handle correctly on its own. A redundant, differently-shaped text-
// extracted duplicate of that SAME H1 period won a "most recently filed"
// tiebreak over the XBRL original and broke whatever made the existing
// XBRL-native handling work, even though the duplicate's own value was
// identical. Cash-flow concepts (ocf/capex) had no equivalent XBRL
// coverage at all for the motivating case (ASC) -- there's nothing for a
// redundant text duplicate to conflict with there.
const CUMULATIVE_FALLBACK_CONCEPTS = new Set(['ocf', 'capex']);

function extractFromTable($, table, targetEndYear, aliasMap) {
  const parsed = parseTableColumns($, table);
  if (!parsed) return null;
  const { columns, dataStartRowIdx } = parsed;

  const targetIdx3mo = columns.findIndex((c) => c.months === 3 && c.year === targetEndYear);
  // Same fiscal year's cumulative (6mo/9mo) column, if this table has one —
  // normally just used for the within-filing reconciliation check below.
  const cumulativeIdx = columns.findIndex((c) => c.months > 3 && c.year === targetEndYear);
  const eligibleForCumulativeFallback = Object.keys(aliasMap).every((c) => CUMULATIVE_FALLBACK_CONCEPTS.has(c));
  // Fallback for a filer whose statement only ever discloses a cumulative
  // (H1/9mo) column, never a standalone 3-month one -- verified live:
  // Ardmore Shipping (ASC)'s cash flow statement shows only "Six Months
  // Ended" columns, no 3-month breakdown at all, so capex (and everything
  // else pulled from that table) previously came back completely empty for
  // every quarter. Use the cumulative column itself as the extracted
  // period in that case, carrying its OWN real duration (6 or 9 months,
  // not a fabricated 3) through to the caller -- the existing decumulation
  // logic in dedupeAndClassify already knows how to turn a real H1/9mo
  // fact into a derived quarter the same way it already does for XBRL H1
  // facts, so nothing downstream of extraction needs to change.
  const usingCumulativeOnly = targetIdx3mo === -1 && eligibleForCumulativeFallback && cumulativeIdx !== -1;
  if (targetIdx3mo === -1 && !usingCumulativeOnly) return null; // this filing doesn't cover the period we're after (or isn't an eligible concept for the cumulative-only fallback)
  const targetIdx = usingCumulativeOnly ? cumulativeIdx : targetIdx3mo;
  const targetPeriod = columns[targetIdx];

  const rows = $(table).find('tr').toArray();
  const candidates = {}; // concept -> [{label, value3mo, valueCumulative}]
  let currentSection = null;
  for (let i = dataStartRowIdx; i < rows.length; i++) {
    const cells = nonEmptyCells($, rows[i]);
    if (!cells.length) continue;
    // Tracks which cash-flow-statement section we're currently inside, so
    // a section-restricted concept (see SECTION_RESTRICTED_CONCEPTS) can't
    // match a same-worded row from the WRONG section -- verified live:
    // Ardmore Shipping (ASC)'s operating-activities section has
    // "Amortization of deferred drydock expenditures" (a non-cash P&L
    // add-back) and "Deferred drydock payments" (already reflected in
    // operating cash flow), neither a real investing outflow, but both
    // matched capex's "drydock" alternative and got summed alongside the
    // genuine investing-section vessel-purchase line by the tiebreak
    // below, corrupting the total. A section-header row has no numeric
    // cells (parseDataRow rejects it below), so this check runs on the
    // RAW cell text, independent of whether the row ends up a real data
    // row at all.
    const rowText = cells.map((c) => c.text).join(' ');
    if (/operating activities/i.test(rowText)) currentSection = 'operating';
    else if (/investing activities/i.test(rowText)) currentSection = 'investing';
    else if (/financing activities/i.test(rowText)) currentSection = 'financing';
    const row = parseDataRow(cells, columns.length);
    if (!row) continue;
    for (const concept of Object.keys(aliasMap)) {
      if (!matchesConcept(row.label, concept)) continue;
      const requiredSection = SECTION_RESTRICTED_CONCEPTS[concept];
      if (requiredSection && currentSection !== requiredSection) continue;
      // value3mo actually means "the value for whatever period we ended up
      // targeting" -- normally a genuine 3-month figure, but the
      // cumulative total itself when that's all this table has. Kept under
      // the same field name so every downstream consumer (ambiguity
      // resolution, the debt-summing tiebreak, recordExtracted) needs no
      // change at all.
      const value3mo = usingCumulativeOnly ? row.values[cumulativeIdx] : row.values[targetIdx3mo];
      const valueCumulative = !usingCumulativeOnly && cumulativeIdx !== -1 ? row.values[cumulativeIdx] : null;
      (candidates[concept] = candidates[concept] || []).push({ label: row.label, value3mo, valueCumulative });
    }
  }

  const results = {};
  for (const [concept, list] of Object.entries(candidates)) {
    // A repeat match is only a genuine conflict if its value actually
    // DIFFERS from an earlier one — verified live: Eldorado Gold (EGO)
    // repeats "Net earnings for the period" verbatim, once as the
    // statement's own subtotal and again after the shareholders/non-
    // controlling-interest attribution breakdown, both carrying the
    // IDENTICAL real figure. Treating any second label match as
    // automatically ambiguous was silently dropping a large share of real,
    // unambiguous matches whenever a filer's presentation repeats a
    // subtotal this way (a common pattern, not specific to EGO).
    const distinct = [];
    for (const c of list) if (!distinct.some((d) => d.value3mo === c.value3mo)) distinct.push(c);
    if (distinct.length === 1) {
      results[concept] = distinct[0];
      continue;
    }
    // Multiple genuinely different values for the same concept — verified
    // live: DEFT breaks revenue into several real sub-lines ("Other
    // revenue", "Revenues excluding realized and net change in unrealized
    // gains (losses)", "Revenues from realized and net change in
    // unrealized gains (losses)") that all match the broad revenue keyword
    // alongside the statement's own "Total revenues" line — a universal
    // accounting-statement convention (sub-items roll up into one "Total"
    // row). When exactly one candidate is unambiguously a total line,
    // prefer it over the sub-items rather than dropping the concept
    // entirely.
    const totalMatches = distinct.filter((d) => /^total\b/i.test(d.label.trim()));
    if (totalMatches.length === 1) { results[concept] = totalMatches[0]; continue; }
    // Still tied — for netIncome specifically, DEFT also discloses a
    // separate "Net income for the period after taxes" alongside "Net
    // income and comprehensive income for the period" (the latter folds in
    // OCI items like currency translation, a genuinely different figure).
    // A PREFERENCE, not an exclude: GreenFire Resources (GFR) has no
    // separate net-income line at all — its only bottom-line total is
    // literally named "Net income (loss) and comprehensive income (loss)"
    // — so this only narrows the set when a non-comprehensive alternative
    // actually exists; GFR's single-candidate case never reaches this
    // branch at all (already returned above).
    if (concept === 'netIncome') {
      const nonComprehensive = distinct.filter((d) => !/comprehensive/i.test(d.label));
      if (nonComprehensive.length === 1) results[concept] = nonComprehensive[0];
    }
    // ocf specifically: a filer can show a pre-tax operating cash flow
    // SUBTOTAL as its own line before subtracting taxes paid down to the
    // real bottom-line figure -- verified live: IAMGOLD (IAG) shows both
    // "Cash from operating activities, before income taxes paid" AND
    // "Net cash from operating activities" as genuinely different real
    // values in the same statement, neither prefixed "Total". The second
    // is the actual OCF figure every other source (XBRL, Finnhub) means
    // by the term -- prefer whichever candidate's label starts with "net
    // cash" when exactly one does.
    if (concept === 'ocf') {
      const netCash = distinct.filter((d) => /^net\s+cash\b/i.test(d.label.trim()));
      if (netCash.length === 1) results[concept] = netCash[0];
    }
    // capex specifically: unlike revenue/netIncome (one bottom-line total
    // rolling up sub-items), a filer can report capex-equivalent outflow
    // as several genuinely separate, non-overlapping lines with no single
    // "Total" row at all -- verified live: Scorpio Tankers (STNG) reports
    // "Acquisition of vessels and payments for vessels under construction"
    // and "Drydock and other vessel related payments" as two distinct real
    // cash-flow lines, neither of which is a subtotal of the other. Summed
    // here as a single synthetic candidate rather than dropped as
    // ambiguous -- safe to attempt because the sum still has to pass the
    // SAME downstream reconciliation (reconcilePoints' cumulative-column
    // and annual-XBRL checks) as any other extracted point before it's
    // ever trusted; an accidental/wrong sum simply fails to verify and
    // gets dropped exactly like a bad single-row match would.
    if (concept === 'capex' && results[concept] === undefined) {
      const value3mo = distinct.reduce((sum, d) => sum + d.value3mo, 0);
      const cumulativeParts = distinct.map((d) => d.valueCumulative);
      const valueCumulative = cumulativeParts.every((v) => v != null) ? cumulativeParts.reduce((sum, v) => sum + v, 0) : null;
      results[concept] = { label: distinct.map((d) => d.label).join(' + '), value3mo, valueCumulative };
    }
    // Any other shape (0 or 2+ candidates after every tiebreak) stays
    // genuinely ambiguous and is dropped, same as before.
  }
  return Object.keys(results).length ? { period: targetPeriod, facts: results } : null;
}

// ---------------------------------------------------------------------------
// Balance-sheet (instant) extraction — equity/debt/cash for ROIC's invested-
// capital side. Deliberately kept as SEPARATE functions from
// extractFromTable/parseTableColumns above rather than generalizing those to
// also handle instant columns: a balance sheet's header has no "months
// ended" phrase at all (just two bare dates — "As of/As at June 30, 2026 /
// December 31, 2025", each its OWN independent snapshot, not a 3mo-vs-6mo
// duration pair), so forcing it through the duration-column parser would
// need special-casing throughout anyway. Keeping this fully additive means
// zero risk of regressing revenue/netIncome/ocf/capex extraction, which
// every foreign-filer ticker already published data depends on.
// ---------------------------------------------------------------------------

// A balance-sheet header row's date cells are the SAME compound "<Month>
// <Day>, <Year>" shape parseDateHeaderCell already recognizes (reused
// as-is, unchanged) — just with no preceding period-length phrase to
// combine with, since each date IS its own complete instant column.
function parseInstantTableColumns($, table) {
  const rows = $(table).find('tr').toArray();
  for (let i = 0; i < rows.length; i++) {
    const cells = nonEmptyCells($, rows[i]);
    const dateCells = cells.map((c) => parseDateHeaderCell(c.text)).filter((d) => d && d.monthDay);
    if (dateCells.length >= 2) {
      const columns = dateCells.map((d) => ({ endMonthDay: d.monthDay, year: d.year }));
      return { columns, dataStartRowIdx: i + 1 };
    }
  }
  return null;
}

// Parses every date column in an already-located balance-sheet <table> —
// unlike extractFromTable (which targets ONE specific quarter), every
// column here is independently useful (a filing's own current-period AND
// prior-year-comparative snapshots are both real, previously-undisclosed-
// elsewhere data points), so this returns one result per column rather than
// a single target period.
function extractFromInstantTable($, table, aliasMap) {
  const parsed = parseInstantTableColumns($, table);
  if (!parsed) return [];
  const { columns, dataStartRowIdx } = parsed;

  const rows = $(table).find('tr').toArray();
  const candidatesByColumn = columns.map(() => ({})); // concept -> [{label, value}]
  for (let i = dataStartRowIdx; i < rows.length; i++) {
    const cells = nonEmptyCells($, rows[i]);
    if (!cells.length) continue;
    const row = parseDataRow(cells, columns.length);
    if (!row) continue;
    for (const concept of Object.keys(aliasMap)) {
      if (!matchesConcept(row.label, concept)) continue;
      for (let c = 0; c < columns.length; c++) {
        (candidatesByColumn[c][concept] = candidatesByColumn[c][concept] || []).push({ label: row.label, value: row.values[c] });
      }
    }
  }

  const out = [];
  for (let c = 0; c < columns.length; c++) {
    const results = {};
    for (const [concept, list] of Object.entries(candidatesByColumn[c])) {
      const distinct = [];
      for (const cand of list) if (!distinct.some((d) => d.value === cand.value)) distinct.push(cand);
      if (distinct.length === 1) { results[concept] = distinct[0]; continue; }
      const totalMatches = distinct.filter((d) => /^total\b/i.test(d.label.trim()));
      if (totalMatches.length === 1) { results[concept] = totalMatches[0]; continue; }
      // debt specifically: current + non-current portions are two real,
      // genuinely separate lines with no single "Total debt" row — see
      // LABEL_ALIASES.debt's own comment. Summed the same way capex's
      // duration-side equivalent is above; safe because the sum still has
      // to pass reconcileInstantPoints before it's ever trusted.
      if (concept === 'debt' && results[concept] === undefined && distinct.length >= 2) {
        results[concept] = { label: distinct.map((d) => d.label).join(' + '), value: distinct.reduce((sum, d) => sum + d.value, 0) };
      }
    }
    if (Object.keys(results).length) out.push({ period: columns[c], facts: results });
  }
  return out;
}

// True for an element with no "real" child elements -- tolerates <br> (a
// heading is sometimes written as "CANGO INC.<br>...BALANCE SHEETS<br>..."
// inside one <b>, which still reads as a single heading string via
// .text() but has element children, so a strict children().length === 0
// check misses it entirely). Verified live: CANG's balance-sheet heading
// is wrapped exactly this way, and its balance-sheet extraction came back
// completely empty as a result -- the table search inside extractStatement/
// extractInstantStatement never even started because no leaf ever matched
// the heading regex.
//
// Tolerating <br> alone is too permissive on its own, though -- verified
// live: AEM's non-GAAP reconciliation table has a row labeled "Production
// costs per the consolidated statements of income<br>(thousands)", whose
// <td> also has only a <br> child, and the label text contains the income-
// statement heading phrase as a substring. A genuine heading occupies its
// OWN row (a caption, alone); this false positive sits in a real data row
// alongside sibling cells holding the row's dollar values. Require the
// enclosing <tr> (if any) to have exactly one non-empty cell -- the heading
// itself -- to tell the two apart. A heading with no enclosing <tr> at all
// (the common case -- a standalone <p>/<div>) is unaffected.
function isHeadingLeaf($, $el) {
  if (!$el.children().toArray().every((c) => c.tagName === 'br')) return false;
  const tr = $el.closest('tr');
  if (!tr.length) return true;
  return nonEmptyCells($, tr[0]).length === 1;
}

// Finds candidate <table>s a heading could belong to. Two real document
// shapes seen so far: (1) STNG/IAG/GDTC/AEM style -- the heading is a
// standalone element and the data table is the next <table> encountered
// scanning forward (the original, extensively-verified behavior -- tried
// first so nothing that already worked can regress); (2) CANG style -- the
// heading is itself the first row/cell *inside* the very table that holds
// the data (its own <table> tag therefore appears BEFORE the heading in
// document order, which a forward-only scan can never reach) -- tried only
// as a fallback, since trusting it FIRST caused a real regression: AEM's
// income-statement heading sits inside a small unrelated wrapper table (a
// by-product-revenue footnote, not the real ~$1.8B statement) that also
// happens to have >=5 rows. Callers try each candidate in turn and keep the
// first one that yields a real result.
function findStatementTables($, allEls, headingIdx) {
  const candidates = [];
  // Enclosing table (structure #2: heading is the table's own first row)
  // tried FIRST when one exists -- it's a stronger authority signal than
  // "whichever table happens to appear next", not just an equally-likely
  // alternative. Verified live this ordering matters, not just which
  // candidates exist: CANG's real, complete income statement is itself
  // structure #2, but a forward scan from its heading lands on an
  // unrelated, smaller supplementary schedule first (a "Net income (loss)"
  // reconciliation table, 27 rows) that still yields a non-null (if
  // partial -- missing ebit/pretaxIncome entirely) result, which used to
  // short-circuit the search before the real, complete enclosing table was
  // ever tried. Safe to prioritize now that isHeadingLeaf's sibling-cell-
  // count check (see its own comment) already filters out AEM's false
  // heading match at the SOURCE -- the ordering here no longer needs to
  // compensate for that, since a genuinely non-heading row can't produce a
  // heading match in the first place anymore.
  const enclosing = $(allEls[headingIdx]).closest('table');
  if (enclosing.length && enclosing.find('tr').length >= 5) candidates.push(enclosing[0]);
  for (let i = headingIdx; i < allEls.length; i++) {
    if (allEls[i].tagName === 'table' && $(allEls[i]).find('tr').length >= 5 && allEls[i] !== candidates[0]) {
      candidates.push(allEls[i]);
      break;
    }
  }
  return candidates;
}

// Locates a statement's heading + immediately-following <table> in a big
// combined document (press release or formal financial-statements exhibit
// — STNG/IAG/CNQ/AEM style), then delegates to extractFromTable.
function extractStatement($, headingRegex, targetEndYear, aliasMap) {
  const allEls = $('body *').toArray();
  const headingIdxs = [];
  for (let i = 0; i < allEls.length; i++) {
    const $el = $(allEls[i]);
    const text = $el.text();
    if (isHeadingLeaf($, $el) && text.length <= MAX_HEADING_TEXT_LENGTH && headingRegex.test(text)) headingIdxs.push(i);
  }
  // A heading can appear more than once, for two different real reasons —
  // verified live for both: (1) IAG's financial-statements exhibit has a
  // table-of-contents entry using the exact same heading text before the
  // real statement -- its "table" candidate simply yields nothing (or a
  // spurious partial), correctly skipped below. (2) NYAX's actual cash-flow
  // statement is split across TWO separate tables under two separate
  // headings -- operating activities (OCF) in the first, investing/
  // financing (capex) in the second -- apparently a page break in the
  // original filing that restates the heading for continuity. Neither
  // table alone is complete; only their union is. MERGE facts across every
  // (heading, table) candidate rather than returning on the first non-null
  // result (which used to let NYAX's first, OCF-only table short-circuit
  // before ever reaching capex) -- first-found wins per CONCEPT on overlap,
  // so a later, less-trustworthy candidate can only fill genuine gaps, never
  // override an already-matched value. The table immediately after a
  // heading is also sometimes a formatting/spacer table, not the actual
  // statement — verified live: GDTC's real "Statements of Cash Flows"
  // heading is followed by a genuine 1-row spacer table before the real
  // (40+ row) data table further down; that candidate yields no result at
  // all and is naturally skipped, same guard extractFromRFile already uses
  // for its own per-page table search.
  let merged = null;
  for (const headingIdx of headingIdxs) {
    for (const table of findStatementTables($, allEls, headingIdx)) {
      const result = extractFromTable($, table, targetEndYear, aliasMap);
      if (!result) continue;
      if (!merged) merged = result;
      else merged = { period: merged.period, facts: { ...result.facts, ...merged.facts } };
    }
  }
  return merged;
}

// Same heading-location shape as extractStatement above, but for the
// balance sheet: every date column is independently useful (see
// extractFromInstantTable), so this returns an ARRAY of results (one per
// column found), not a single target-period result.
function extractInstantStatement($, headingRegex, aliasMap) {
  const allEls = $('body *').toArray();
  const headingIdxs = [];
  for (let i = 0; i < allEls.length; i++) {
    const $el = $(allEls[i]);
    const text = $el.text();
    if (isHeadingLeaf($, $el) && text.length <= MAX_HEADING_TEXT_LENGTH && headingRegex.test(text)) headingIdxs.push(i);
  }
  // Same "keep the most complete match, not just the first" reasoning as
  // extractStatement above -- a duplicate/summary heading's table could
  // just as easily win a subset of columns/concepts here otherwise. Summed
  // across every period in the result, since this returns one entry PER
  // DATE COLUMN rather than a single result.
  let best = null;
  let bestFactCount = 0;
  for (const headingIdx of headingIdxs) {
    for (const table of findStatementTables($, allEls, headingIdx)) {
      const result = extractFromInstantTable($, table, aliasMap);
      const factCount = result.reduce((sum, r) => sum + Object.keys(r.facts).length, 0);
      if (result.length && factCount > bestFactCount) {
        best = result;
        bestFactCount = factCount;
      }
    }
  }
  return best || [];
}

// SEC auto-renders each individual XBRL-tagged statement of an Inline XBRL
// filing into its own small standalone page (R2.htm, R3.htm, ... — one per
// statement/note), listed with real statement names in the filing's own
// FilingSummary.xml manifest (see fetchFilingSummaryReports). Verified
// live: GreenFire Resources/GFR's R3.htm is literally titled "Condensed
// Interim Consolidated Statements of Comprehensive Income (Loss)
// (Unaudited)" with the identical "Three months ended/Six months ended"
// column structure extractFromTable already parses — just packaged as its
// OWN page rather than embedded in one large combined document. No heading
// search needed here at all (FilingSummary.xml already told the caller
// which R-file is which statement) — but the page has many small auxiliary
// tables (verified live: 51 <table> elements on GFR's R3.htm, mostly
// tiny/formatting), so this picks the first one that's substantial enough
// to plausibly be the real statement (more than a few rows) rather than
// just grabbing the literal first <table>.
function extractFromRFile($, targetEndYear, aliasMap) {
  const tables = $('table').toArray();
  for (const table of tables) {
    if ($(table).find('tr').length < 5) continue;
    const result = extractFromTable($, table, targetEndYear, aliasMap);
    if (result) return result;
  }
  return null;
}

function subtractMonths(dateStr, months) {
  const d = new Date(dateStr);
  const result = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - months, d.getUTCDate()));
  return result.toISOString().slice(0, 10);
}

function subtractThreeMonths(dateStr) {
  return subtractMonths(dateStr, 3);
}

function monthDayYearToIso(endMonthDay, year) {
  const d = new Date(`${endMonthDay}, ${year} UTC`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

async function fetchExhibitCandidates(cik, filing, userAgent) {
  const accessionNoDashes = filing.accessionNumber.replace(/-/g, '');
  const indexUrl = `${SEC_ARCHIVES_BASE}/${Number(cik)}/${accessionNoDashes}/${filing.accessionNumber}-index.htm`;
  const indexHtml = await fetchText(indexUrl, userAgent);
  if (!indexHtml) return [];
  const $ = cheerio.load(indexHtml);
  const candidates = [];
  $('table.tableFile tr').each((i, tr) => {
    const cells = $(tr)
      .find('td')
      .map((j, td) => $(td).text().trim())
      .get();
    if (cells.length < 5) return;
    const [, , filename, type, sizeStr] = cells;
    const size = parseInt(sizeStr, 10);
    if (!filename || !/\.(htm|html)$/i.test(filename)) return;
    if (type && /GRAPHIC|XML|EXCEL/i.test(type)) return;
    if (!size || size < MIN_EXHIBIT_BYTES) return;
    candidates.push(`${SEC_ARCHIVES_BASE}/${Number(cik)}/${accessionNoDashes}/${filename}`);
  });
  return candidates;
}

// SEC's own manifest for an Inline XBRL filing — lists every auto-rendered
// per-statement page (R2.htm, R3.htm, ...) with its real statement name.
// Verified live: 404s cleanly for filings that aren't Inline XBRL-tagged
// (STNG's press-release-style 6-Ks have no FilingSummary.xml at all), so
// callers can try this first and fall back to the exhibit-scan path
// without any special-casing. Simple regex extraction (not cheerio/XML-
// mode) — the same lightweight-parsing choice already made for the 13F
// info table in the sibling smart-money-pipeline repo, since the shape is
// this consistent and SEC-generated.
async function fetchFilingSummaryReports(cik, accessionNumber, userAgent) {
  const accessionNoDashes = accessionNumber.replace(/-/g, '');
  const url = `${SEC_ARCHIVES_BASE}/${Number(cik)}/${accessionNoDashes}/FilingSummary.xml`;
  const xml = await fetchText(url, userAgent);
  if (!xml) return [];
  const reports = [];
  const blocks = xml.match(/<Report[\s\S]*?<\/Report>/gi) || [];
  for (const block of blocks) {
    const htmlFileName = block.match(/<HtmlFileName>([^<]+)<\/HtmlFileName>/i)?.[1]?.trim();
    const shortName = block.match(/<ShortName>([^<]+)<\/ShortName>/i)?.[1]?.trim();
    const longName = block.match(/<LongName>([^<]+)<\/LongName>/i)?.[1]?.trim();
    if (htmlFileName && (shortName || longName)) reports.push({ htmlFileName, shortName: shortName || '', longName: longName || '' });
  }
  return reports;
}

/**
 * Extracts standalone-quarter facts for `neededConcepts` (subset of
 * ['revenue','netIncome','ocf','capex']) by scanning a ticker's recent 6-K
 * exhibits. `annualByEnd` maps ISO end-date -> real annual XBRL value per
 * concept (from the caller's already-computed `revenue.annual` etc.) — the
 * reconciliation anchor; a concept with no annual data to reconcile
 * against is never attempted (matches the "only fall back when the real
 * data is genuinely missing, and only when verifiable" policy).
 *
 * Returns { [concept]: Array<{start, end, val, filed}> } — same shape as
 * extractFactSeries, ready to merge into the caller's raw fact arrays
 * before dedupeAndClassify runs.
 */
async function extractQuarterlyFactsFromFilings(cik, neededConcepts, annualByEnd, userAgent) {
  const submissions = await fetchJsonSec(`${SEC_SUBMISSIONS_BASE}/CIK${cik}.json`, userAgent);
  if (!submissions?.filings?.recent) return {};

  const r = submissions.filings.recent;
  const filings = [];
  for (let i = 0; i < r.form.length && i < FILING_LOOKBACK_ENTRIES && filings.length < MAX_FILINGS_TO_SCAN; i++) {
    const size = r.size?.[i];
    if (r.form[i] === '6-K' && (size == null || size >= MIN_SUBSTANTIVE_FILING_BYTES)) {
      filings.push({ accessionNumber: r.accessionNumber[i], filingDate: r.filingDate[i] });
    }
  }

  // concept -> Map(end -> Array<{val, valueCumulative, start, filed, accessionNumber}>)
  // An array, not a single overwrite-once slot — verified live this matters:
  // many foreign filers (DEFT, CMBT, and likely most of this bucket) only
  // ever disclose ONE standalone quarter per fiscal year, with no same-
  // document cumulative column at all, so neither of reconcilePoints' two
  // existing checks (adjacent-quarter-vs-cumulative, or 2+-quarters-vs-
  // annual) can ever verify them - not a parsing gap, a structural
  // reconciliation-coverage gap. Keeping every independent filing's own
  // value for the same real period (instead of discarding repeats) enables
  // a third, arithmetic-free check: the SAME quarter's value disclosed
  // identically in the filing that reports it AND, a year later, in the
  // filing that shows it as the prior-year comparative column - literal
  // agreement between two independent real documents.
  const collected = { revenue: new Map(), netIncome: new Map(), ebit: new Map(), pretaxIncome: new Map(), ocf: new Map(), capex: new Map(), equity: new Map(), debt: new Map(), cash: new Map() };
  const aliasMap = {};
  for (const c of neededConcepts) if (LABEL_ALIASES[c]) aliasMap[c] = LABEL_ALIASES[c];

  // Set DEBUG_FILING_EXTRACT=1 to trace discovery/extraction per filing —
  // useful when diagnosing why a specific ticker isn't producing results
  // during the staged manual rollout (see the plan's "Rollout" section).
  const debug = !!process.env.DEBUG_FILING_EXTRACT;

  // Records an extraction result into `collected`, shared by both the
  // R-file path and the exhibit-scan path below. `filings` array is built
  // from `r.form[i] === '6-K'` exactly (never '6-K/A'), so any two entries
  // here are genuinely independent original filings, not a filing and its
  // own amendment.
  function recordExtracted(extracted, filing) {
    if (!extracted) return;
    const endIso = monthDayYearToIso(extracted.period.endMonthDay, extracted.period.year);
    if (!endIso) return;
    // Uses the period's OWN real duration (usually 3 months, but 6 or 9
    // when extractFromTable fell back to a cumulative-only column -- see
    // its own comment) rather than always assuming 3, so a genuine H1/9mo
    // fact gets a correctly-spanning start date instead of a fabricated
    // one -- required for dedupeAndClassify to classify it into the right
    // bucket (h1/q3ytd) and decumulate it downstream the same way an XBRL
    // H1 fact already would be.
    const startIso = subtractMonths(endIso, extracted.period.months);
    for (const [concept, fact] of Object.entries(extracted.facts)) {
      const list = collected[concept].get(endIso) || [];
      if (!list.some((l) => l.accessionNumber === filing.accessionNumber)) {
        list.push({ start: startIso, end: endIso, val: fact.value3mo, valueCumulative: fact.valueCumulative, filed: filing.filingDate, accessionNumber: filing.accessionNumber });
      }
      collected[concept].set(endIso, list);
    }
  }

  // Instant-fact counterpart to recordExtracted above — no start date (a
  // balance-sheet snapshot has no duration), and extractFromInstantTable
  // already returns one entry PER DATE COLUMN, so this is called once per
  // column rather than once per statement.
  function recordExtractedInstant(extractedList, filing) {
    for (const extracted of extractedList) {
      const endIso = monthDayYearToIso(extracted.period.endMonthDay, extracted.period.year);
      if (!endIso) continue;
      for (const [concept, fact] of Object.entries(extracted.facts)) {
        const list = collected[concept].get(endIso) || [];
        if (!list.some((l) => l.accessionNumber === filing.accessionNumber)) {
          list.push({ end: endIso, val: fact.value, filed: filing.filingDate, accessionNumber: filing.accessionNumber });
        }
        collected[concept].set(endIso, list);
      }
    }
  }

  for (const filing of filings) {
    // FilingSummary.xml path first — SEC's own manifest for Inline XBRL
    // filings, pointing directly at the exact page for each statement
    // (verified live: GreenFire Resources/GFR's R3.htm is authoritatively
    // named "...Statements of Comprehensive Income..." in this manifest).
    // Far cheaper and more targeted than the exhibit-scan below (1 manifest
    // fetch + only the 1-2 R-files that actually match, vs. blindly
    // fetching up to 6 large documents per filing) — tried first, and
    // skips the exhibit-scan entirely for this filing when it succeeds.
    // 404s cleanly (empty array) for non-Inline-XBRL filers (verified live
    // for STNG), so this never interferes with the existing path.
    let usedFilingSummary = false;
    try {
      const reports = await fetchFilingSummaryReports(cik, filing.accessionNumber, userAgent);
      if (reports.length) {
        const candidateYears = [String(new Date(filing.filingDate).getUTCFullYear()), String(new Date(filing.filingDate).getUTCFullYear() - 1)];
        const incomeAliases = Object.fromEntries(Object.entries({ revenue: aliasMap.revenue, netIncome: aliasMap.netIncome, ebit: aliasMap.ebit, pretaxIncome: aliasMap.pretaxIncome }).filter(([, v]) => v));
        const cashflowAliases = Object.fromEntries(Object.entries({ ocf: aliasMap.ocf, capex: aliasMap.capex }).filter(([, v]) => v));
        const matches = [
          ...(Object.keys(incomeAliases).length ? reports.filter((rep) => STATEMENT_HEADINGS.income.test(rep.shortName) || STATEMENT_HEADINGS.income.test(rep.longName)).map((rep) => ({ rep, aliases: incomeAliases })) : []),
          ...(Object.keys(cashflowAliases).length ? reports.filter((rep) => STATEMENT_HEADINGS.cashflow.test(rep.shortName) || STATEMENT_HEADINGS.cashflow.test(rep.longName)).map((rep) => ({ rep, aliases: cashflowAliases })) : []),
        ];
        if (matches.length) usedFilingSummary = true;
        for (const { rep, aliases } of matches) {
          const accessionNoDashes = filing.accessionNumber.replace(/-/g, '');
          const rUrl = `${SEC_ARCHIVES_BASE}/${Number(cik)}/${accessionNoDashes}/${rep.htmlFileName}`;
          const html = await fetchText(rUrl, userAgent);
          if (debug) console.error('DEBUG R-file', rUrl, rep.shortName || rep.longName);
          if (!html) continue;
          const $ = cheerio.load(html);
          for (const year of candidateYears) {
            let extracted;
            try {
              extracted = extractFromRFile($, year, aliases);
            } catch (e) {
              if (debug) console.error('DEBUG extractFromRFile threw', rUrl, year, e.message);
              continue;
            }
            if (debug) console.error('DEBUG extractFromRFile result', rUrl, year, JSON.stringify(extracted));
            recordExtracted(extracted, filing);
          }
        }
      }
    } catch (e) {
      if (debug) console.error('DEBUG fetchFilingSummaryReports threw', filing.accessionNumber, e.message);
    }
    if (usedFilingSummary) continue;

    let exhibitUrls;
    try {
      exhibitUrls = await fetchExhibitCandidates(cik, filing, userAgent);
    } catch (e) {
      if (debug) console.error('DEBUG fetchExhibitCandidates threw', filing.accessionNumber, e.message);
      continue;
    }
    if (debug) console.error('DEBUG', filing.accessionNumber, 'candidates:', exhibitUrls);

    for (const url of exhibitUrls) {
      let html;
      try {
        html = await fetchText(url, userAgent);
      } catch (e) {
        if (debug) console.error('DEBUG fetchText threw', url, e.message);
        continue;
      }
      if (!html) { if (debug) console.error('DEBUG empty html', url); continue; }
      const $ = cheerio.load(html);
      const fullText = $('body').text();
      const hasIncome = STATEMENT_HEADINGS.income.test(fullText);
      const hasCashflow = STATEMENT_HEADINGS.cashflow.test(fullText);
      const hasBalanceSheet = STATEMENT_HEADINGS.balanceSheet.test(fullText);
      if (debug) console.error('DEBUG', url, 'hasIncome', hasIncome, 'hasCashflow', hasCashflow, 'hasBalanceSheet', hasBalanceSheet);
      if (!hasIncome && !hasCashflow && !hasBalanceSheet) continue;

      // Try every year we might plausibly need (this filing's own filing
      // year and the one prior) rather than assuming which quarter it covers.
      const candidateYears = [String(new Date(filing.filingDate).getUTCFullYear()), String(new Date(filing.filingDate).getUTCFullYear() - 1)];

      for (const heading of [STATEMENT_HEADINGS.income, STATEMENT_HEADINGS.cashflow]) {
        const incomeAliases = { revenue: aliasMap.revenue, netIncome: aliasMap.netIncome, ebit: aliasMap.ebit, pretaxIncome: aliasMap.pretaxIncome };
        const cashflowAliases = { ocf: aliasMap.ocf, capex: aliasMap.capex };
        const relevantAliases = heading === STATEMENT_HEADINGS.income ? incomeAliases : cashflowAliases;
        const filtered = Object.fromEntries(Object.entries(relevantAliases).filter(([, v]) => v));
        if (!Object.keys(filtered).length) continue;

        for (const year of candidateYears) {
          let extracted;
          try {
            extracted = extractStatement($, heading, year, filtered);
          } catch (e) {
            if (debug) console.error('DEBUG extractStatement threw', url, year, e.message);
            continue;
          }
          if (debug) console.error('DEBUG extractStatement result', url, year, JSON.stringify(extracted));
          recordExtracted(extracted, filing);
        }
      }

      const balanceSheetAliases = Object.fromEntries(Object.entries({ equity: aliasMap.equity, debt: aliasMap.debt, cash: aliasMap.cash }).filter(([, v]) => v));
      if (Object.keys(balanceSheetAliases).length) {
        let extractedList;
        try {
          extractedList = extractInstantStatement($, STATEMENT_HEADINGS.balanceSheet, balanceSheetAliases);
        } catch (e) {
          if (debug) console.error('DEBUG extractInstantStatement threw', url, e.message);
          extractedList = [];
        }
        if (debug) console.error('DEBUG extractInstantStatement result', url, JSON.stringify(extractedList));
        recordExtractedInstant(extractedList, filing);
      }
    }
  }

  // Reconciliation — never return an unverified point. Two independent
  // checks, either of which verifies a point:
  //   A. Consecutive-pair vs. same-document cumulative: this point's own
  //      "6mo"/"9mo" column (valueCumulative, captured from the SAME row/
  //      document as its 3mo value — see extractStatement) should equal
  //      it plus the immediately preceding quarter's value. Works for the
  //      CURRENT, still-in-progress fiscal year — verified live: STNG's
  //      Q1'26 ($312,860k) + Q2'26 ($408,734k) = $721,594k, an exact match
  //      to Q2's own disclosed six-month cumulative figure.
  //   B. Full fiscal year vs. real annual XBRL: only usable once a fiscal
  //      year has actually closed and its annual XBRL fact exists — a
  //      necessary second path since check A alone never verifies an
  //      ISOLATED quarter with no adjacent quarter collected.
  // A permutation bug (e.g. Q1/Q2 swapped) cannot pass check A, since it
  // depends on order-sensitive addition against a real disclosed subtotal,
  // not just an order-insensitive sum.
  const pointsByConcept = new Map();
  // Instant concepts only (see reconcileInstantPoints' sibling-trust pass
  // below): accession number -> set of end-dates this same filing produced
  // for this concept. Built from the RAW per-end-date lists (every filing
  // that mentioned this concept at all), not just each end-date's winning
  // "best" value, so a sibling lookup can't miss a real same-document
  // relationship just because that filing's value lost a corroboration tie
  // for its OWN date.
  const accessionToDatesByConcept = new Map();
  for (const concept of neededConcepts) {
    const grouped = collected[concept] || new Map();
    const points = [];
    const accessionToDates = new Map();
    for (const [end, list] of grouped) {
      if (!list.length) continue;
      for (const l of list) {
        if (!accessionToDates.has(l.accessionNumber)) accessionToDates.set(l.accessionNumber, new Set());
        accessionToDates.get(l.accessionNumber).add(end);
      }
      // Group this end-date's occurrences (one per independent filing) by
      // their disclosed value, and pick the value with the most independent
      // corroborations (ties broken by most-recently-filed) as the
      // representative point — feeds Check C below.
      const byValue = new Map();
      for (const l of list) {
        if (!byValue.has(l.val)) byValue.set(l.val, []);
        byValue.get(l.val).push(l);
      }
      let best = null;
      for (const occurrences of byValue.values()) {
        if (!best || occurrences.length > best.length) best = occurrences;
      }
      const rep = best.slice().sort((a, b) => new Date(b.filed) - new Date(a.filed))[0];
      points.push({ ...rep, corroborations: new Set(best.map((o) => o.accessionNumber)).size, accessionNumbers: new Set(best.map((o) => o.accessionNumber)) });
    }
    points.sort((a, b) => new Date(a.end) - new Date(b.end));
    if (points.length) pointsByConcept.set(concept, points);
    accessionToDatesByConcept.set(concept, accessionToDates);
  }

  // Auto-detect and correct a systematic unit-scale mismatch BEFORE
  // reconciliation runs — verified live: STNG's and AEM's own earnings-
  // release tables are denominated "in thousands" (see the Q1'26/Q2'26
  // comment above, itself written with a "k" suffix), but nothing upstream
  // ever multiplies the parsed cell value by 1000 to match XBRL's
  // raw-dollar convention. This stays invisible to Check A above
  // (self-consistent: a thousands-scale quarter plus a thousands-scale
  // quarter still equals a thousands-scale cumulative) and to Check C
  // (also self-consistent, cross-filing agreement) — only Check B, which
  // compares against the real annual XBRL dollar figure, would ever catch
  // it, and only for a concept with enough recent real annual data to
  // check against. Detected ONCE across ALL of this filing's concepts
  // together, not per concept — verified live: EGO's revenue has a recent
  // XBRL annual anchor to detect against, but its OCF/capex annual XBRL
  // data stops at 2019-2020, far too old to anchor 2024-2026 quarterly
  // points on its own. Every concept here comes from the SAME earnings-
  // release document, which uses one unit convention throughout (a real
  // filing never mixes "revenue in millions" with "OCF in thousands" in
  // the same release) — so whichever concept DOES have a confident recent
  // anchor (usually revenue) correctly carries the other concepts along
  // with it, rather than leaving them uncorrected for lack of their own
  // evidence.
  const scale = detectScaleMultiplier(pointsByConcept, annualByEnd);
  if (scale !== 1) {
    for (const points of pointsByConcept.values()) {
      for (const p of points) {
        p.val *= scale;
        if (p.valueCumulative != null) p.valueCumulative *= scale;
      }
    }
  }

  const result = {};
  for (const [concept, points] of pointsByConcept) {
    const verified = INSTANT_CONCEPTS.has(concept)
      ? reconcileInstantPoints(points, annualByEnd?.[concept] || new Map(), accessionToDatesByConcept.get(concept))
      : reconcilePoints(points, annualByEnd?.[concept] || new Map());
    if (verified.length) {
      result[concept] = verified.map((p) => ({ start: p.start, end: p.end, val: p.val, filed: p.filed }));
    }
  }
  return result;
}

function isAdjacentDate(dateA, dateB) {
  const gapDays = Math.abs((new Date(dateB) - new Date(dateA)) / (1000 * 60 * 60 * 24));
  return gapDays <= 5;
}

// See the call site's own comment for the full rationale — this just picks
// the multiplier. Candidates cover the two real conventions seen in the
// wild (thousands, millions) plus their inverses for symmetry, though a
// table denominated MORE finely than XBRL's raw dollars has never actually
// been observed.
const SCALE_CANDIDATES = [1, 1000, 1000000, 0.001, 0.000001];

// pointsByConcept: Map<concept, points[]>. annualByEnd: { [concept]:
// Map<end, {end, value}> }. Scores each candidate scale against EVERY
// concept's own evidence and sums the scores together — a concept with no
// usable recent annual anchor of its own (score 0 for every candidate)
// simply doesn't vote, rather than dragging the shared result back to "no
// correction"; see the call site for why sharing one scale across concepts
// from the same filing is the right model in the first place.
function detectScaleMultiplier(pointsByConcept, annualByEnd) {
  let bestScale = 1;
  let bestScore = -1;
  for (const scale of SCALE_CANDIDATES) {
    let score = 0;
    for (const [concept, points] of pointsByConcept) {
      const annuals = annualByEnd?.[concept];
      if (!annuals || !annuals.size) continue;

      const byYear = new Map();
      for (const p of points) {
        const year = p.end.slice(0, 4);
        if (!byYear.has(year)) byYear.set(year, []);
        byYear.get(year).push(p);
      }

      for (const annual of annuals.values()) {
        if (!annual.value) continue;
        const fyEndYear = annual.end.slice(0, 4);
        const candidates = byYear.get(fyEndYear) || [];
        if (candidates.length < 2) continue;
        const sum = candidates.reduce((s, p) => s + p.val * scale, 0);
        const ratio = sum / annual.value;
        // 2-3 real quarters of a real fiscal year should land roughly in
        // [30%, 105%] of that year's total (generous bounds for
        // seasonality and the possibility all 4 are present) — not a
        // sliver of the year (a scale mismatch) and not wildly over it.
        if (ratio >= 0.3 && ratio <= 1.05) score++;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestScale = scale;
    }
  }
  return bestScore > 0 ? bestScale : 1;
}

const INSTANT_CONCEPTS = new Set(['equity', 'debt', 'cash']);

// Instant-fact counterpart to reconcilePoints below. Deliberately NOT the
// same function with a branch inside it: reconcilePoints' Check A/B are
// both flow-specific (summing MULTIPLE periods together to match a
// cumulative-column or annual total) -- semantically meaningless for a
// point-in-time balance-sheet snapshot, and reusing them risked an
// accidental coincidental match verifying a wrong value. Two checks here,
// both genuinely valid for instant facts:
//   C. Cross-filing corroboration (identical to reconcilePoints' own Check
//      C) -- the same real value at the same date, independently disclosed
//      in 2+ separate filings (e.g. this filing's own current-period
//      column, and a year later, the SAME date reappearing as another
//      filing's prior-year comparative column).
//   B'. Direct match against a REAL XBRL instant fact at the SAME end
//      date -- not a sum, just point equality within tolerance, tried
//      across SCALE_CANDIDATES (not just the raw value) since detectScaleMultiplier
//      (the flow-concept scale detector, run once per filing above) isn't
//      safe to reuse here -- its own algorithm sums MULTIPLE periods to
//      approximate a fraction of an annual total, meaningless for a
//      point-in-time snapshot, so it never actually detects an instant
//      concept's own scale; it just lets whatever scale the FLOW concepts
//      happened to need ride along, which is only correct when a filer's
//      balance sheet and income statement share one convention. Verified
//      live this isn't always true: REAX's real XBRL equity for
//      2023-12-31 is $37,084,000, but the text-extracted value merged in
//      as bare $37,084 (a genuine "in thousands" balance-sheet table) even
//      though its flow concepts needed no scaling at all -- corrupted
//      investedCapitalMap down to an absurd figure, silently breaking ROIC
//      for periods that used to compute fine. Checking per-point against
//      its own real anchor, independent of whatever the flow concepts
//      decided, catches this the way a single borrowed global scale can't.
function reconcileInstantPoints(points, knownByEnd, accessionToDates) {
  const verified = new Set();
  for (const p of points) if (p.corroborations >= 2) verified.add(p);
  for (const p of points) {
    const known = knownByEnd.get(p.end);
    if (known?.value == null) continue;
    for (const scale of SCALE_CANDIDATES) {
      const scaledVal = p.val * scale;
      const diff = Math.abs(scaledVal - known.value) / Math.abs(known.value);
      if (diff <= RECONCILE_TOLERANCE) {
        p.val = scaledVal;
        p.appliedScale = scale;
        verified.add(p);
        break;
      }
    }
  }

  // Sibling-column trust: a point sharing a filing (same accession number)
  // with an already-verified point for the SAME concept -- in practice
  // almost always the same physical table, just a different date column --
  // is trusted too. A balance-sheet snapshot has no cumulative-sum identity
  // to self-check the way flow concepts do (see reconcilePoints' Check A),
  // so corroboration/XBRL-match alone leaves genuinely correct INTERIM
  // (non-fiscal-year-end) points permanently unverifiable for any filer
  // that only ever discloses a given quarter once -- verified live: CANG's
  // real, correctly-extracted Sept 30 2025 balance sheet had no way to ever
  // pass either existing check, since its own filing convention only ever
  // re-discloses the prior FISCAL YEAR END as a comparative (never the same
  // interim quarter a year later), and CANG furnishes just one 6-K per
  // quarter (no separate press-release + full-financials pair the way some
  // other filers do, which independently corroborates BOTH columns of a
  // table right away). Scoped to same accession number rather than
  // literal table identity, which isn't tracked this far downstream --
  // accepted as a safe approximation since a single 6-K's exhibits all
  // describe one filer's one true financial position for that filing
  // event. Non-transitive by construction (checked against a snapshot of
  // the base-verified set, not the growing one) -- a point can be trusted
  // via a directly base-verified sibling, never via a chain of siblings
  // trusting siblings. Propagates the sibling's own scale correction (if
  // any), since two columns of the same table share one unit convention --
  // a table needing "x1000" for its FYE column (the one with a real XBRL
  // anchor to check against) needs it for every other column too.
  if (accessionToDates) {
    const baseVerified = new Set(verified);
    const byEnd = new Map(points.map((p) => [p.end, p]));
    for (const p of points) {
      if (verified.has(p)) continue;
      for (const accession of p.accessionNumbers || []) {
        const siblingEnds = accessionToDates.get(accession);
        if (!siblingEnds) continue;
        const sibling = [...siblingEnds].map((end) => byEnd.get(end)).find((q) => q && q !== p && baseVerified.has(q));
        if (sibling) {
          if (sibling.appliedScale) p.val *= sibling.appliedScale;
          verified.add(p);
          break;
        }
      }
    }
  }

  return points.filter((p) => verified.has(p));
}

function reconcilePoints(points, annualByEnd) {
  const verified = new Set();

  // Check C — cross-filing corroboration: the SAME real value for this
  // exact period was independently disclosed in 2+ separate 6-K filings
  // (e.g. as this year's own current-quarter figure, and again a year
  // later as the prior-year comparative column). No arithmetic assumption
  // at all — just literal agreement between independent real documents.
  // Verified live this is necessary, not just nice-to-have: DEFT and CMBT
  // (and most of this bucket) only ever disclose ONE standalone quarter per
  // fiscal year with no same-document cumulative column, so Check A (needs
  // a cumulative column) and Check B (needs 2+ quarters in the SAME fiscal
  // year) can never verify them, no matter how correct the extraction is.
  for (const p of points) if (p.corroborations >= 2) verified.add(p);

  // Check A — this point's own disclosed cumulative vs. the sum of
  // consecutive real quarters within the same fiscal year up to and
  // including this point. Walks back as many adjacent quarters as are
  // actually collected (not hardcoded to exactly one prior quarter) —
  // verified live: ALM's "three months ended Sept 30" column discloses a
  // NINE-month YTD cumulative (Jan-Sep), not a six-month one, so it only
  // reconciles against Q1+Q2+Q3 summed, not just the immediately-preceding
  // quarter. A filer whose cumulative column is a genuine six-month figure
  // still resolves in one step (chain length 2), unchanged from before.
  for (const p of points) {
    if (p.valueCumulative == null) continue;
    const chain = [p];
    let cursor = p;
    for (;;) {
      const prior = points.find((q) => !chain.includes(q) && isAdjacentDate(q.end, cursor.start));
      if (!prior) break;
      chain.push(prior);
      cursor = prior;
    }
    for (let take = 2; take <= chain.length; take++) {
      const subset = chain.slice(0, take);
      const sum = subset.reduce((s, x) => s + x.val, 0);
      const diff = Math.abs(sum - p.valueCumulative) / Math.abs(p.valueCumulative);
      if (diff <= RECONCILE_TOLERANCE) {
        subset.forEach((x) => verified.add(x));
        break;
      }
    }
  }

  // Check B — full fiscal year vs. real annual XBRL value.
  if (annualByEnd.size) {
    const byYear = new Map();
    for (const p of points) {
      const year = p.end.slice(0, 4);
      if (!byYear.has(year)) byYear.set(year, []);
      byYear.get(year).push(p);
    }
    for (const annual of annualByEnd.values()) {
      if (!annual.value) continue;
      const fyEndYear = annual.end.slice(0, 4);
      // p.start is a SYNTHETIC approximation (subtractThreeMonths from the
      // real disclosed end date), not itself a disclosed fact - verified
      // live this matters: a Q1 quarter ending March 31 synthesizes a start
      // of December 31 (calendar-month subtraction, correct arithmetic),
      // exactly one day before a real annual fact's clean January 1 start.
      // An exact p.start >= annual.start comparison wrongly excluded a real
      // Q1 quarter from its own fiscal year's reconciliation candidates
      // over that single day. A small tolerance ONLY on the lower bound
      // (not a full adjacency match, which would also wrongly constrain
      // Q2/Q3/Q4's much-later starts) fixes this while still requiring
      // every candidate to fall within the fiscal year.
      const startToleranceMs = 5 * 24 * 60 * 60 * 1000;
      const candidates = (byYear.get(fyEndYear) || []).filter((p) => p.end <= annual.end && new Date(p.start).getTime() >= new Date(annual.start).getTime() - startToleranceMs);
      if (candidates.length < 2) continue; // too little to meaningfully reconcile
      const sum = candidates.reduce((s, p) => s + p.val, 0);
      const diff = Math.abs(sum - annual.value) / Math.abs(annual.value);
      if (diff <= RECONCILE_TOLERANCE) candidates.forEach((c) => verified.add(c));
    }
  }

  return points.filter((p) => verified.has(p));
}

module.exports = {
  parseNumericCell,
  isYearCell,
  parsePeriodPhrase,
  parseTableColumns,
  parseDataRow,
  extractStatement,
  subtractThreeMonths,
  monthDayYearToIso,
  reconcilePoints,
  reconcileInstantPoints,
  detectScaleMultiplier,
  parseInstantTableColumns,
  extractFromInstantTable,
  extractInstantStatement,
  extractQuarterlyFactsFromFilings,
  throttleSecRequest,
};
