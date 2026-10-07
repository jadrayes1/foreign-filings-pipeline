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
// 3, not 1 or 2 -- deliberately buys cross-filing corroboration (Check C),
// not just raw coverage: a 20-F's own comparative table already carries
// 2-3 fiscal years, so two CONSECUTIVE 20-Fs overlap in 2 of their 3 years,
// letting Check C verify those years the same way it verifies 6-K-derived
// quarters, without needing Check D's section-subtotal self-check at all
// for anything but the single newest, not-yet-echoed fiscal year. Verified
// live for DHT: its 3 most recent 20-Fs (filed 2026/2025/2024) cover
// FY2021-2025 with FY2022-2024 double-corroborated -- closes the actual
// known gap (FY2022+) with margin.
const MAX_20F_FILINGS_TO_SCAN = 3;
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
// routine noise entirely. Lowered from 200,000 -- verified live this was
// silently excluding IMPP's own real quarterly earnings-release exhibits
// entirely: its genuine standalone-Q1 filings (e.g. 189,759 bytes filed
// 2025-05-23, with a real "Three Month Periods Ended March 31, 2024 2025"
// cash-flow statement including real capex) sit just under the old
// threshold, so IMPP's quarterly data was never even ATTEMPTED, not
// genuinely unextractable -- the earlier "IMPP has no standalone quarter
// anywhere" conclusion was wrong, reached without checking this filing at
// all. Set comfortably above CMBT's known 149,098-byte routine ceiling
// (the highest routine ceiling seen so far) while now also comfortably
// below IMPP's real ~189-190K filings.
const MIN_SUBSTANTIVE_FILING_BYTES = 160000;
// Per-filer override for the global threshold above -- needed because a
// single byte cutoff can't always separate one filer's real filings from
// another's routine ones when their size profiles overlap. Verified live:
// CAAS's real Q3'25 (146,056-byte exhibit) and Q2'26 (136,014-byte exhibit)
// earnings releases -- both confirmed genuine via real "Three/Nine Months
// Ended"/"Net income" tables -- sit BELOW the global threshold entirely
// (submission totals 157,276 and 148,382 bytes), while its own routine
// filings (merger/listing notices) top out at 55,388 bytes -- a clean gap,
// just one this filer's real filings don't clear the shared 160,000 floor
// tuned for CMBT's higher 149,098-byte routine ceiling. Only add an entry
// after confirming (like CAAS above) that the filer's own real filings and
// routine filings are cleanly separable at the chosen value -- same
// hand-verified-only philosophy as CIK_CONTINUITY_ALIASES/FDIC_BANK_CERTS
// elsewhere in this codebase, never an automatic per-filer heuristic.
const MIN_SUBSTANTIVE_FILING_BYTES_OVERRIDES = {
  CAAS: 100000, // comfortably above its 55,388-byte routine ceiling, below its 146,056-byte real floor
};

// Per-filer native reporting currency -- every OTHER filer this pipeline
// handles either reports natively in USD or discloses a parallel USD
// convenience-translation column the currency-triple/group-label logic
// above already picks out (CURRENCY_CODE_CELL/UNIT_CURRENCY_LABEL_CELL).
// Verified live: TSM (Taiwan Semiconductor)'s real quarterly "Consolidated
// Financial Statements" exhibit (e.g. tsmc2025q1consolidatdfinan.htm)
// states every table "(In Thousands of New Taiwan Dollars...)" with NO
// USD column anywhere -- USD only ever appears in unstructured prose
// elsewhere ("In US dollars, revenue was $40.20 billion"). Hand-verified
// only, same philosophy as MIN_SUBSTANTIVE_FILING_BYTES_OVERRIDES/
// CIK_CONTINUITY_ALIASES above -- never an automatic per-filer currency
// detector (a wrong guess here would silently corrupt every value it
// touches, worse than leaving the gap alone). Add an entry only after
// confirming the filer's own structured tables truly carry no USD column
// at all (reconciliation would otherwise catch a scale error eventually,
// but a currency error can clear reconciliation entirely e.g. two TWD
// figures agreeing with each other). See convertNativeCurrencyToUsd's own
// comment for the conversion methodology and its own verification.
const NATIVE_CURRENCY_OVERRIDES = {
  TSM: 'TWD',
};

// --- Native-currency-to-USD conversion ---------------------------------
// For filers in NATIVE_CURRENCY_OVERRIDES above, whose structured tables
// provide no USD column at all (unlike the currency-triple/convenience-
// translation shapes the rest of this file already handles). Uses the
// Federal Reserve's own published daily exchange rate (FRED series, free,
// no API key: https://fred.stlouisfed.org/graph/fredgraph.csv?id=<series>)
// -- verified live for TWD: averaging DEXTAUS (New Taiwan Dollars per US
// dollar) across 2026 Q2 (Apr 1 - Jun 30) gives $40.198B against TSMC's own
// disclosed "$40.20 billion" Q2'26 USD revenue, on a $40.2B base -- i.e.
// the exact methodology TSMC itself uses for its own USD disclosure, not
// an independently-chosen approximation.
//
// A DURATION (flow) concept -- revenue/netIncome/ebit/pretaxIncome/ocf/
// capex, every one of this file's income-statement and cash-flow concepts
// -- is converted using the AVERAGE daily rate across its own [start, end]
// window, the standard convenience-translation convention for a flow
// figure (confirmed by the TSM verification above). An INSTANT (balance-
// sheet) concept -- equity/debt/cash -- instead uses the single rate as of
// (or nearest before) its own end date, the standard convention for a
// point-in-time balance, never an average over a period it doesn't span.
const FX_SERIES_BY_CURRENCY = {
  // Do not add a currency here without the same kind of independent
  // verification against a real, filer-disclosed USD figure (see comment
  // above) -- an unverified series id or rate direction would silently
  // corrupt every value it touches, which is worse than leaving the gap.
  TWD: 'DEXTAUS',
};

const fxRateSeriesCache = new Map(); // currency code -> sorted [{date, rate}] | null, fetched at most once per process

async function fetchFxRateSeries(currency) {
  if (fxRateSeriesCache.has(currency)) return fxRateSeriesCache.get(currency);
  const seriesId = FX_SERIES_BY_CURRENCY[currency];
  if (!seriesId) {
    fxRateSeriesCache.set(currency, null);
    return null;
  }
  let series = null;
  try {
    const res = await fetchWithTimeout(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${seriesId}`, {});
    if (res.ok) {
      const csv = await res.text();
      series = csv
        .trim()
        .split('\n')
        .slice(1) // header row
        .map((line) => {
          const [date, rawVal] = line.split(',');
          const rate = Number(rawVal);
          return date && Number.isFinite(rate) ? { date, rate } : null;
        })
        .filter(Boolean);
    }
  } catch {
    series = null;
    // Non-fatal -- same graceful-degradation philosophy as every other
    // network fetch in this file. A failed FX fetch just means this
    // filer's points can't be converted (and so aren't recorded) this run,
    // not a thrown error that would take down every other concept/filing.
  }
  fxRateSeriesCache.set(currency, series);
  return series;
}

// Mean of every daily rate within [startIso, endIso] inclusive -- the
// convenience-translation convention for a flow figure, see this section's
// own header comment for the live TSM verification.
function averageFxRate(series, startIso, endIso) {
  const inRange = series.filter((p) => p.date >= startIso && p.date <= endIso);
  if (!inRange.length) return null;
  return inRange.reduce((sum, p) => sum + p.rate, 0) / inRange.length;
}

// The most recent real rate ON OR BEFORE endIso -- the convention for a
// point-in-time balance. Falls back to the earliest available rate only
// when every real rate is AFTER endIso (a period older than this file's
// own fetched window), rather than returning null for a plausible date
// just outside the exact window.
function nearestFxRateOnOrBefore(series, endIso) {
  let best = null;
  for (const p of series) {
    if (p.date > endIso) continue;
    if (!best || p.date > best.date) best = p;
  }
  return best ? best.rate : series.length ? series[0].rate : null;
}

// `period` is {start, end} (ISO strings) for a duration concept, or just
// {end} for an instant one (start omitted/null). Returns null (never a
// guessed value) when no currency override applies, the FX fetch failed,
// or no rate exists anywhere near the requested date -- the caller treats
// null exactly like any other unextractable value, never publishing a
// fabricated figure.
async function convertNativeCurrencyToUsd(value, currency, period) {
  const series = await fetchFxRateSeries(currency);
  if (!series || !series.length) return null;
  const rate = period.start ? averageFxRate(series, period.start, period.end) : nearestFxRateOnOrBefore(series, period.end);
  return rate ? value / rate : null;
}
const FILING_LOOKBACK_ENTRIES = 400; // how far into submissions.json's 'recent' list to look for size-qualifying candidates
const MIN_EXHIBIT_BYTES = 20000; // cover-page heuristic — verified live: STNG's 6-K cover page was 11,450 bytes, its real earnings exhibit 733,171 bytes
const RECONCILE_TOLERANCE = 0.02; // 2%

// A TENTH header shape, verified live: PDD Holdings (and, by the same
// filing-agent earnings-release template, VIPS/ZTO/likely many other major
// Chinese ADRs) discloses each period in a real currency triple -- prior-
// year RMB, current-year RMB, current-year US$ (a "for convenience only"
// translation, standard SEC boilerplate for a foreign private issuer whose
// functional currency isn't USD) -- under ONE shared year cell for the
// current year: "2025"(colspan=2) "2026"(colspan=6)" | "RMB"(colspan=2)
// "RMB"(colspan=2) "US$"(colspan=2)" -- so the date row's own cell COUNT
// (2 per phrase) undercounts the real column count (3 per phrase) by
// exactly the convenience-translation column, and every data row's real
// value count (matching the 3-per-phrase reality) mismatches
// parseDataRow's columns.length check, silently rejecting the entire
// table. CURRENCY_CODE_CELL only matches a cell whose ENTIRE text is a
// bare currency code/symbol -- never fires on ordinary label or value
// cells, which always carry more than just a currency marker.
const CURRENCY_CODE_CELL = /^(RMB|US\$|USD|HK\$|HKD|CN¥|CNY|EUR|€|GBP|£|JPY|¥|CAD|AUD|SGD|S\$)$/i;
// The standard SEC "reader convenience" translation currency for a foreign
// private issuer -- always the derived, secondary figure, mathematically
// redundant with the native-currency column it's translated from. Verified
// live: PDD's own document states this explicitly elsewhere ("translation
// of Renminbi amounts into U.S. dollars...for the convenience of the
// reader"). Dropped rather than kept since every downstream reconciliation
// check in this file already assumes one consistent currency per concept
// (see extractFactSeries' own currency-mixing fix in the sibling XBRL
// path) -- keeping BOTH would silently blend RMB and USD magnitudes under
// the same (months, year) key.
const CONVENIENCE_TRANSLATION_CURRENCY = /^(US\$|USD)$/i;
// An ELEVENTH header shape, verified live: IRSA Inversiones y
// Representaciones (IRS) discloses each period in a real currency pair --
// native ARS and a USD convenience translation -- but unlike PDD's shape
// above (a shared year cell UNDERCOUNTING real columns, needing
// expansion), IRSA's date row already has the CORRECT number of separate
// cells (three: "2025" "2025" "2024", no colspan-sharing) -- the row right
// below instead carries a GROUP label per currency, "(in millions of
// USD)"(colspan=1) "(in millions of ARS)"(colspan=2), fewer cells than
// date columns rather than more. Nothing distinguished the two same-
// (months,year) "2025" columns, so targetIdx3mo's own findIndex just
// grabbed the FIRST one (USD, ~94) over the real ARS figure (~129,259)
// every time. Captures just the currency code, not a fixed alternation
// list -- CONVENIENCE_TRANSLATION_CURRENCY below is what actually decides
// USD vs. not, so this only needs to isolate the code, never validate
// which native currency it is.
const UNIT_CURRENCY_LABEL_CELL = /\(in\s+(?:thousands|millions|billions)\s+of\s+([A-Z][A-Z$€£¥]{1,4})\)/i;

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
  // "STATEMENTS OF OPERATING RESULTS" added -- verified live: Brookfield
  // Business Corporation (BBUC) titles its real primary income statement
  // "Unaudited Interim Condensed Consolidated Statements of Operating
  // Results", never "...of Income"/"...of Operations"/etc. Without this,
  // the coarse hasIncome flag (checked against the WHOLE page's text, not
  // per-heading) came back true anyway -- from BBUC's SEPARATE, real
  // "Consolidated Statements of Comprehensive Income" heading elsewhere in
  // the same document -- while extractStatement's own heading search (one
  // regex test per heading ELEMENT) found nothing to extract from at all,
  // since neither this table's real title nor that unrelated one's
  // narrower comprehensive-income content actually carries a usable
  // revenue/net-income line the same way. Genuinely misleading: hasIncome
  // looked satisfied while the real statement was never even located.
  // "STATEMENTS OF NET INCOME" added -- verified live: BRP Inc. (DOO)
  // titles its real primary income statement "Condensed Consolidated
  // Interim Statements of Net Income", which the "(COMPREHENSIVE )?INCOME"
  // group doesn't cover (only "COMPREHENSIVE " is optional there, not
  // "NET "). Same misleading-hasIncome shape as BBUC above: DOO's page
  // also has a separate, real "...Statements of Comprehensive Income"
  // heading that satisfied the coarse whole-page hasIncome check while
  // the actual statement with revenue/net-income lines was never located.
  // Every word-boundary space below is \s+ (or \s* where the space is
  // meant to be optional), not a literal " " -- verified live: Haoxin
  // Holdings (HXHX)'s real cash-flow heading is wrapped mid-phrase in its
  // own source HTML, "Unaudited Condensed Consolidated Statement\nof Cash
  // Flows" (a genuine line-wrap artifact inside one <B> tag, not a
  // rendering quirk cheerio introduces) -- a literal space between
  // "Statement" and "of" never matches a literal newline there, so hasCashflow
  // was false for HXHX despite the real heading being present verbatim.
  // The leading "CONSOLIDATED\s+STATEMENTS?" gap was already \s+-tolerant
  // (fixed earlier for DHT's own "CONSOLIDATED\nSTATEMENT OF CASH FLOW"),
  // but that fix was never extended to the OTHER internal spaces in these
  // same patterns -- inconsistent, and exactly what HXHX's real document
  // tripped on next.
  // "STATEMENTS OF LOSS (AND COMPREHENSIVE LOSS)?" added -- verified live:
  // Cybin Inc. (HELP), a pre-revenue clinical-stage biotech, titles its
  // real primary statement "Condensed Interim Consolidated Statements of
  // Loss and Comprehensive Loss" -- a genuinely different phrase from
  // "...of Profit or Loss" (already covered) or any "...INCOME" variant,
  // since this filer never has income to report at all. Same misleading-
  // hasIncome shape as BBUC/DOO above if left unfixed (a real net-loss
  // figure sitting right there, unreachable because no heading pattern
  // recognized its own statement's title).
  // "SUMMARY OF ... INCOME DATA" / "... CASH FLOW DATA" added below --
  // verified live: ZTO Express (ZTO)'s real quarterly earnings-release
  // exhibit (a shared template with PDD/VIPS -- see the "costs? of" fix's
  // own comment above) never uses a "STATEMENT(S) OF ..." caption at all
  // for its primary tables -- they're titled "Summary of Unaudited
  // Consolidated Comprehensive Income Data" and "Summary of Unaudited
  // Consolidated Cash Flow Data" instead, a genuinely different word order
  // ("Summary of ... Data" wrapping the statement name, not "Statement(s)
  // of ..."). Without this, extractStatement's own per-heading search
  // never located either table, even though the coarse whole-page
  // hasIncome/hasCashflow flags happened to read true from unrelated text
  // elsewhere in the same document -- the same misleading-hasIncome shape
  // already documented above for BBUC/DOO. The real table gives ZTO's
  // standalone "Three Months Ended" figures directly, side by side with
  // the "Six Months Ended" cumulative column -- no decumulation needed.
  income:
    /CONSOLIDATED\s+(?:CONDENSED\s+|INTERIM\s+|UNAUDITED\s+)*(STATEMENTS?\s+OF\s+(COMPREHENSIVE\s+|NET\s+)?INCOME|STATEMENTS?\s+OF\s+OPERATIONS|STATEMENTS?\s+OF\s+OPERATING\s+RESULTS|STATEMENTS?\s+OF\s+EARNINGS|INCOME\s+STATEMENTS?|STATEMENTS?\s+OF\s+PROFIT\s+OR\s+LOSS|STATEMENTS?\s+OF\s+LOSS(?:\s+AND\s+COMPREHENSIVE\s+LOSS)?)|SUMMARY\s+OF\s+(?:UNAUDITED\s+|CONDENSED\s+|INTERIM\s+)*CONSOLIDATED\s+(?:COMPREHENSIVE\s+)?INCOME\s+DATA/i,
  // "FLOWS?" (trailing S optional) -- verified live: DHT's cash-flow
  // statement is headed "CONSOLIDATED\nSTATEMENT OF CASH FLOW (UNAUDITED)",
  // genuinely singular throughout ("Statement", not "Statements"; "Flow",
  // not "Flows"). "STATEMENTS?" already tolerated the singular/plural
  // difference for the first word -- inconsistent that "FLOWS" was left
  // mandatory-plural right next to it. hasCashflow was false for every one
  // of DHT's real documents as a result, so capex/ocf extraction never
  // even attempted to run for this filer.
  cashflow:
    /CONSOLIDATED\s+(?:CONDENSED\s+|INTERIM\s+|UNAUDITED\s+)*STATEMENTS?\s+OF\s+CASH\s*FLOWS?|SUMMARY\s+OF\s+(?:UNAUDITED\s+|CONDENSED\s+|INTERIM\s+)*CONSOLIDATED\s+CASH\s*FLOWS?\s+DATA/i,
  // Not anchored on "CONSOLIDATED" needing to be the very first word — same
  // reasoning as income/cashflow above (the regex isn't `^`-anchored, so
  // "Condensed Consolidated Balance Sheets" still matches via the
  // "Consolidated Balance Sheets" substring). Verified live: STNG uses
  // "Condensed Consolidated Balance Sheets", IAG uses plain "Consolidated
  // Balance Sheets" with no extra qualifiers.
  balanceSheet: /CONSOLIDATED\s+(?:CONDENSED\s+|INTERIM\s+|UNAUDITED\s+)*(BALANCE\s+SHEETS?|STATEMENTS?\s+OF\s+FINANCIAL\s+POSITION)/i,
  // Weighted-average share count lives in its OWN note, not under the main
  // income-statement heading -- verified live: TNK's real income
  // statement table has no share-count row at all; the actual "Weighted
  // average number of common shares - basic/diluted" table sits under a
  // separate numbered footnote, "16. Earnings Per Share" (part of "NOTES
  // TO THE UNAUDITED CONSOLIDATED FINANCIAL STATEMENTS"). Not anchored on
  // a leading number (varies by filer) or "CONSOLIDATED" -- this is a note
  // title, not a primary statement title, so it doesn't share those
  // primary statements' naming convention.
  earningsPerShare: /EARNINGS\s+PER\s+(COMMON\s+)?SHARE/i,
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
    // "costs? of" (not just singular "cost of") -- verified live: PDD
    // Holdings' real income statement labels its COGS line "Costs of
    // revenues" (plural "Costs"), which /cost of/i does NOT match as a
    // substring ("costs of" != "cost of") -- so this row survived as an
    // unexcluded second candidate alongside the real "Revenues" line,
    // making revenue AMBIGUOUS (2 different-valued candidates, no way to
    // resolve) and silently dropping it entirely -- for every single
    // quarter across 5 years, since this is PDD's standard label on every
    // filing. The same earnings-release template is shared by VIPS/ZTO/
    // likely other major Chinese ADRs (see the dual-currency table header
    // fix's own comment on this file for the same shared-template pattern).
    exclude: /costs? of|growth|per share|marketing|deferred|unearned|allowance|\btax\b|discontinued|forecast|guidance|gain on/i,
  },
  netIncome: {
    // "net profit" added -- verified live: Copa Holdings (CPA) labels its
    // bottom line "Net Profit/(Loss)" (and plain "Net profit" elsewhere in
    // the same document), never "net income" -- a distinct real caption
    // from the existing "profit (loss)"/"profit for the period" patterns,
    // which require "profit" to come FIRST. "income for the period/year"
    // added -- verified live: Corporacion America Airports (CAAP) labels
    // its bottom line "Income for the period" (never "net income" or any
    // "profit..." phrasing) -- the existing "\bbefore\b" exclude already
    // keeps this from also matching "Income before income tax"/"Income
    // before financial results and income tax", both real lines earlier
    // in the same statement.
    include: /net (income|earnings|loss|profit)\b|\bprofit \(loss\)\b|\bprofit for the (period|year)\b|\bincome for the (period|year)\b/i,
    // "non-gaap" added -- verified live: Vipshop (VIPS)'s earnings release
    // includes a real GAAP-to-non-GAAP reconciliation table with its own
    // row, "Non-GAAP net income attributable to Vipshop's shareholders" --
    // a genuinely different (adjusted) figure from the real GAAP "Net
    // income attributable to Vipshop's shareholders" line, but one that
    // matches BOTH the base include pattern AND the "attributable to
    // (parent)" tiebreak below just as well, recreating the exact same
    // ambiguity that tiebreak exists to resolve. Non-GAAP net income
    // (excludes share-based comp, one-time items, etc.) is never the right
    // input for a GAAP-basis profitMargin ratio regardless -- this is a
    // routine disclosure for any Chinese ADR that reports a non-GAAP
    // adjusted figure alongside GAAP, not specific to VIPS.
    // "\bbasic\b|\bdiluted\b" added -- verified live: VIPS's real EPS rows
    // are labeled "Net income attributable to Vipshop's shareholders--
    // Basic"/"...--Diluted" (per-ADS dollar figures, e.g. 44.74) -- the
    // existing "shares?\b" exclude doesn't catch these (the label says
    // "shareholders", not "shares"/"share", and \b never matches mid-word
    // after "share" in "shareholders"). Each Basic/Diluted row carries a
    // genuinely different numeric value from the real aggregate net-income
    // row and from each other, so without this they multiply the
    // "attributable to (parent)" tiebreak's candidate count well past 1,
    // defeating that tiebreak even after the non-GAAP exclude above.
    // "net income tax" added -- verified live: PAC (Grupo Aeroportuario
    // del Pacifico)'s statement of changes in equity has an OCI
    // remeasurement line, "Remeasurements of employee benefit – net income
    // tax" -- means "net OF income tax", completely unrelated to the real
    // net-income metric, but matches the base include pattern's "net
    // income\b" alternative as a plain substring (the \b after "income"
    // only requires a word boundary, which the following space satisfies).
    // This single false candidate, with its own small, different value,
    // made resolveConceptCandidates see two disagreeing "netIncome"
    // candidates in the SAME table as the real "Net income" row and bail
    // on the ambiguity -- silently losing a real, otherwise-cleanly-
    // extracted value, not just adding a wrong one.
    exclude: /shares?\b|attributable to (non|minority)|from (continuing|discontinued)|margin|growth|\bbefore\b|non-gaap|\bbasic\b|\bdiluted\b|net income tax/i,
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
    // "non-?operating" added -- verified live: TSM's real income statement
    // has a "Total non-operating income and expenses" subtotal (the
    // interest/FX/equity-method-investment section below the real operating-
    // income line), which the include pattern's own "operating income"
    // alternative matches as a plain substring ("non-operating income"
    // contains it) with no word-boundary protecting the "non-" prefix.
    // This single wrong match (value ~$24M) beat the real "INCOME FROM
    // OPERATIONS" subtotal (value ~$407M) in the ambiguity tiebreak below,
    // silently producing an EBIT figure ~17x too small. A non-operating
    // section is definitionally the opposite of what this concept wants.
    exclude: /per share|margin|growth|^other\b|non-?operating/i,
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
  // EBIT proxy of last resort, ONLY requested for a hand-curated allowlist
  // (DERIVE_EBIT_FROM_EXPENSES_TICKERS in generateForeignFilingsCache.js)
  // -- a filer with genuinely zero revenue whose statement has no
  // operating-income/pretax-income line at all (verified live: Cybin Inc./
  // HELP goes straight from TOTAL EXPENSES to NET LOSS FOR THE PERIOD, via
  // a non-operating "OTHER INCOME (EXPENSES)" section in between). For a
  // company with $0 revenue, -(TOTAL EXPENSES) IS the operating loss
  // exactly, not an approximation -- but that equivalence only holds when
  // revenue is genuinely absent, so this concept is deliberately never
  // requested for a ticker not on that allowlist (each entry individually
  // verified to have zero revenue before being added), rather than folded
  // into ebit/pretaxIncome's own broader, ungated patterns.
  totalExpenses: {
    include: /total expenses?/i,
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
    // "operating cash flow" (reversed word order, no "from"/"provided by"
    // verb) added -- verified live: TNK labels its three cash-flow
    // subtotals "Net operating cash flow"/"Net financing cash flow"/"Net
    // investing cash flow" -- the sibling "financing"/"investing" lines
    // are still safely excluded below since they contain those words.
    // Tolerant of a "(used in)"/"(loss)"-style parenthetical wedged
    // between "cash" and the action verb -- verified live: HXHX (Haoxin
    // Holdings) labels this line "Net cash (used in) provided by
    // operating activities", the SAME dual-framing convention already
    // handled for pretaxIncome's own "(loss)" parenthetical just above,
    // never applied here too.
    include: /cash (flows? )?(\([^)]*\)\s*)?(from|provided by|generated (from|by)|used in|inflow|outflow).*operating|operating cash flow/i,
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
    // "acquisition(s)?( and \w+)? of vessels" tolerates ONE inserted phrase
    // before "of vessels", mirroring "purchase(s)? of( \w+)? property"'s
    // own tolerance above -- verified live: IMPP's real line is
    // "Acquisition and improvement of vessels", a FOURTH distinct real-
    // world phrasing, which the original "acquisition(s)? of vessels" (no
    // gap allowed) never matched.
    // "expenditures? for( \w+)? (vessels?|property)" added -- verified
    // live: Teekay Tankers (TNK) labels its real investing-section capex
    // line "Expenditures for vessels and equipment", a FIFTH distinct
    // real-world phrasing -- neither "capital expenditures" (no "for X"
    // suffix) nor any vessel/property alternative above (all anchored on
    // "acquisition"/"purchase"/"investment", none on bare "expenditures")
    // matched it. Found in TNK's own separate, fuller "Consolidated
    // Statements of Cash Flows" 6-K exhibit (its condensed earnings-release
    // exhibit omits the investing section entirely) -- the extractor
    // already scans both filings; only the label pattern was the gap.
    //
    // "vessels? acquisitions?" (noun-first order, not "acquisition OF
    // vessels") and "deposits? for( \w+)? (vessel|property) purchase"
    // added -- verified live: TNK's SAME investing section also has
    // "Vessel acquisitions" and "Deposit for vessel purchase" as two
    // FURTHER real, much LARGER lines (its actual dominant capex driver --
    // real annual capex is $70-190M/year, while "Expenditures for vessels
    // and equipment" alone is only a few hundred thousand to a few million
    // per quarter) that the "acquisition(s)? of vessels" alternative never
    // matched, since the word order is reversed here ("Vessel
    // acquisitions", not "acquisition of vessels"). Silently understated
    // TNK's real capex by roughly 95%+ until found -- the existing
    // capex-summing tiebreak in resolveConceptCandidates already combines
    // every matching line in the same section, so no further change is
    // needed beyond recognizing these two additional real phrasings.
    // "propert(y|ies) additions" (noun-first order) added -- verified live:
    // Canadian National Railway (CNI) labels its real investing-section
    // capex line "Property additions", a SIXTH distinct real-world phrasing
    // -- the reverse word order of the existing "additions to property"
    // alternative, same reversed-order gap already seen for TNK's "vessel
    // acquisitions" vs. "acquisition of vessels". CNI's netIncome/ebit/
    // revenue/ocf text-extraction all already worked and reached Q2'26;
    // capex alone returned zero candidates, which is why only fcfMargin/
    // P-FCF (not profitMargin/revenueGrowth) were stuck.
    // Bare "(Mineral) property, plant and equipment" (no verb/preposition at
    // all) added, anchored to the WHOLE label -- verified live: Alamos Gold
    // (AGI) labels its real investing-section capex line just "Mineral
    // property, plant and equipment", a SEVENTH distinct real-world
    // phrasing with no "purchase of"/"acquisition of"/"additions to" prefix
    // to anchor on. Deliberately anchored (^...$, not a bare substring test
    // like every other alternative here) rather than a generic
    // "\bproperty,? plant and equipment\b" -- that phrase also legitimately
    // appears embedded in unrelated lines within the same cash-flow
    // statement (e.g. "Depreciation of property, plant and equipment", an
    // operating-activities adjustment, or "Gain on disposal of property,
    // plant and equipment") that are NOT capex; anchoring to the full label
    // matches only when the row's entire text IS the asset name itself.
    // "concession" alternatives added -- verified live: ASR (Grupo
    // Aeroportuario del Sureste, an airport CONCESSION operator) uses TWO
    // genuinely different real phrasings for the SAME capex concept across
    // its OWN filings -- "Investments in machinery, furniture, equipment
    // and concession improvements" (6-K earnings release) and
    // "Improvements to assets under concession and acquisition of
    // furniture and equipment" (20-F annual R-file) -- neither matching
    // "vessels" nor "property" (an airport concession holder improves the
    // CONCESSION right itself, not owned real estate, so "property" never
    // appears in its own capex line at all). Not anchored to a specific
    // leading verb ("investments in"/"improvements to") since that's
    // exactly what varies between the two -- just requires "concession"
    // to co-occur with one of the asset words every real phrasing shares.
    // "concession" is the fixed anchor every Mexican airport-concession
    // operator (ASR/PAC/OMAB, all under the same regulatory concession
    // structure) plausibly shares, since all three file under the same
    // IFRS convention for an identical business model.
    include: /capital expenditures?|purchase(s)? of( \w+)? property|acquisition(s)? of( \w+)? property|investments? in( \w+)? (vessels?|property)|investments? in.*concession|concession.*(improvements?|furniture|equipment)|improvements?.*concession|expenditures? for( \w+)? (vessels?|property)|additions to (property|oil and gas|exploration)|propert(y|ies) additions|acquisition(s)?( and \w+)? of vessels|vessels? acquisitions?|deposits? for( \w+)? (vessel|property) purchase|drydock|^(mineral )?propert(y|ies),? plant and equipment$/i,
    exclude: /proceeds|disposal|\bsale of\b|depreciation|amortization|gain on|loss on/i,
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
    // "^equity$" (anchored to the WHOLE label, not a substring test like
    // every other alternative here) added -- verified live: Super Group
    // (SGHC) labels its real grand-total equity row just "EQUITY" (bare,
    // no "Total" qualifier at all, distinct from "Equity attributable to
    // owners of the parent" one line above it in the SAME table, which is
    // a real but different, non-total figure). Anchoring to the full label
    // is required here -- a generic unanchored "\bequity\b" would also
    // match that non-total line and several others in the same section.
    // "(shareholder|stockholder)s?('s|s'|s)?" -- verified live: PAC (Grupo
    // Aeroportuario del Pacifico) labels its real grand-total equity row
    // "Total stockholder's equity" -- SINGULAR "stockholder" with a
    // possessive "'s", not the plural "stockholders(')" every other
    // alternative here already covered. The old fixed "stockholders"
    // substring (plural, no apostrophe) never matched "stockholder's" at
    // all (missing the second "s" before the apostrophe), silently
    // dropping PAC's equity row from EVERY cadence -- same failure shape
    // whether the row is otherwise perfectly clean or not.
    include: /total (shareholder|stockholder)s?('s|s'|s)?\s+equity|total equity|^equity$/i,
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
  // Weighted-average share count -- for generateForeignPfcfCache.js's
  // per-share P/FCF calculation. Verified live: TNK's real income
  // statement has this as a genuine table row ("Weighted average number of
  // common shares - basic (1)" / "...diluted"), not prose -- confirmed
  // extractable via the same table-based infrastructure every other
  // concept here already uses. NOT every filer discloses this in a table
  // though -- verified live: STNG's real earnings exhibit states its
  // share count ONLY as a narrative sentence ("the Company's basic
  // weighted average number of shares outstanding were X and Y,
  // respectively"), nowhere as a table row in the whole document --
  // genuinely unextractable by this include/exclude, label-matching
  // system (built entirely around <table> rows), not a pattern-coverage
  // gap. Left unaddressed by design -- a prose parser is a different
  // mechanism with no infrastructure to reuse here.
  shares: {
    // "weighted[-]average" tolerates a hyphen, not just a space -- verified
    // live: CNI (Canadian National Railway) labels its real rows
    // "Weighted-average basic shares outstanding"/"...diluted shares
    // outstanding", hyphenated, which the space-only pattern never matched
    // -- same class of gap as parsePeriodPhrase's own "[\s-]months?" fix
    // (BRP/DOO's "Three-month periods ended"), just never applied here too.
    include: /weighted[\s-]average (number of )?(common )?shares?( outstanding)?/i,
    exclude: /dilutive effect|per share/i,
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
// Widened from 150 -- root-caused live 2026-09-17: the scheduled full run
// (generate-foreign-filings-cache.yml) has been hitting its 350-minute
// timeout on real, observed pace (700/764 tickers processed before
// cancellation, both 2026-09-15 and 2026-09-16 runs) — 350 is already
// within ~10 minutes of GitHub Actions' own 360-minute hard ceiling for a
// single job on standard runners, so raising timeout-minutes further isn't
// a real option. This IS the dominant bottleneck (per this function's own
// design note above: workers spend most of their time blocked here, not on
// other CPU-bound work), so tightening it directly cuts wall-clock time
// roughly proportionally. 120ms -> ~8.3 req/sec, still a real ~17% margin
// under SEC's own ~10 req/sec fair-use guidance (previously ~33% margin at
// 150ms) -- a deliberate, modest trade of unused headroom for enough extra
// throughput (~20%) to comfortably clear the full 764-ticker universe
// within the existing timeout, without ever exceeding SEC's stated limit.
const MIN_REQUEST_INTERVAL_MS = 120; // ~8.3 req/sec aggregate — still a real margin under SEC's ~10 req/sec fair-use guidance
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
//
// Non-USD currency prefix (e.g. "R$ 38,092,050" on SBS's own R-file row,
// Brazilian Real) is stripped BEFORE the old `[()$,\s]`-only cleanup --
// verified live: that cleanup only ever stripped a bare "$", so "R$" left
// a stray leading "R" that failed the digits-only regex below and silently
// dropped the whole value (the row's LABEL still matched fine, just with
// no parseable number -- same failure shape as a missing concept, not an
// obviously-wrong one, which is why it went unnoticed). Only the FIRST
// value row of an R-file statement typically carries the symbol at all
// (a rendering convention, not per-row) -- other currency symbols that
// appear across this pipeline's known foreign-filer universe are covered
// the same way (C$/A$/HK$/NT$/S$ two-or-three-letter-code-plus-$, plus
// bare £/€/¥ for filers that use those instead of a letter-code form).
function parseNumericCell(text) {
  const t = text.trim().replace(/^(\()?[A-Z]{0,3}\$/, '$1').replace(/^(\()?[£€¥]/, '$1').trim();
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
    // ​ (zero-width space) added alongside \s -- verified live: NBIS's
    // real HTML uses a lone zero-width space as an invisible spacer cell
    // between real data cells ("Net cash...|<ZWSP>|(184.1)|<ZWSP>|2,258.0"),
    // rendering as visually empty but NOT matched by JS's own \s character
    // class (unlike a real space/tab/nbsp), so it survived as a "non-empty"
    // cell and inflated every row's cell count past columns.length --
    // silently rejecting every data row in the table as malformed.
    .map((c) => ({ text: $(c).text().replace(/[\s​]+/g, ' ').trim(), colspan: parseInt($(c).attr('colspan') || '1', 10) }))
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
// "( periods?)?" tolerates "Period(s)" inserted before "Ended" -- verified
// live: IMPP's real header reads "Three Month Periods EndedMarch 31,"
// (also missing the space before the month name entirely -- see the date
// match below), which neither "months? ended" nor any prior IMPP-specific
// fix here matched, since "Periods" sits directly between "Month" and
// "Ended". This ticker in particular has surfaced several distinct real
// header phrasings already (see "Quarters Ended" above) -- another
// legitimate variant, not a one-off typo.
// \s+ (not a literal space) before "period(s)"/"ended" -- verified live:
// ASR's real cash-flow caption line-wraps as "Six-month\nperiods ended June
// 30, 2026 and 2025" (a genuine newline where a literal space sat in every
// other filer's single-line version of this phrase) -- silently failed to
// match at all, leaving findExternalPeriodPhrases with nothing and the
// cash-flow table's own bare "2026 | 2025" year columns with no duration
// to pair against (this table has no in-row period phrase of its own,
// unlike ASR's income statement a few pages earlier, which does and so
// was unaffected). Same newline-vs-space artifact already fixed for
// STATEMENT_HEADINGS' own internal spaces (see HXHX's comment there) --
// just never extended to this indicator.
const PERIOD_PHRASE_INDICATOR = /months?\s+(periods?\s+)?ended|quarters?\s+(periods?\s+)?ended|years?\s+(periods?\s+)?ended/i;

function parsePeriodPhrase(text) {
  // "months?" (not just plural "months") on every count -- verified live:
  // IMPP's real phrase is "Three Month Periods..." (singular "Month"), not
  // "Three Months...". "[\s-]" (not just a literal space) between the
  // number word and "month(s)" -- verified live: BRP (DOO)'s real header
  // reads "Three-month periods ended"/"Six-month periods ended"/"Nine-month
  // periods ended" (hyphenated compound adjective), which a literal-space
  // "three months?" never matched, silently leaving periodPhrases null for
  // the rest of this table's own parsing forever (every row after the
  // header returns null too, not just this one).
  const months = /nine[\s-]months?|9[\s-]months?/i.test(text)
    ? 9
    : /six[\s-]months?|6[\s-]months?/i.test(text)
      ? 6
      : /three[\s-]months?|3[\s-]months?|quarters?[\s-]ended/i.test(text)
        ? 3
        : /twelve[\s-]months?|12[\s-]months?|years?[\s-]ended/i.test(text)
          ? 12
          : null;
  if (!months) return null;
  // \s* (not \s+) after "ended" -- verified live: IMPP's real header has no
  // space at all between "Ended" and the month name ("EndedMarch 31,"),
  // likely two adjacent inline elements with no text node between them in
  // the source HTML (same class of artifact as the already-documented
  // "Jun 302026" no-space case elsewhere in this file).
  const dateMatch = text.match(/ended\s*([A-Za-z]+\s+\d{1,2})/i);
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
  // ASR-style "2Q 2026"/"2Q 2025" year-row cell -- a bare year prefixed
  // with its own quarter number, verified live in ASR's H1 2026 interim
  // 6-K, which pairs a "Six months period ended"/"Three months period
  // ended" phrase row with a shared "June 30," month-day row and THIS
  // quarter-labeled year row, instead of a plain "2026"/"2025" the way
  // every other filer's three-month column labels its year. Without this,
  // isYearCell/the compound match above both reject it outright, so
  // dateCells silently undercounts (misses the two real standalone-quarter
  // columns entirely), which cascades into a wrong phrase-to-column
  // allocation and a data-row count mismatch -- losing BOTH the real
  // six-month AND the real three-month data for this table, not just the
  // quarter. Only the year is extracted (the quarter-number prefix is
  // redundant with the phrase row's own stated duration, not needed here).
  const quarterYear = text.trim().match(/^[1-4]Q\s*((?:19|20)\d{2})$/i);
  if (quarterYear) return { year: quarterYear[1], monthDay: null };
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

// Standard calendar-aligned quarter/year end for a known duration, used as
// a LAST-RESORT fallback (see both call sites below) when a header gives a
// real duration but no way to date it at all. Never applied blindly for a
// non-calendar fiscal year (e.g. BMO's Oct 31 year end) -- a wrong guess
// here just lands the point at a date real annual XBRL has no match for,
// so it fails Check A/B/C reconciliation and is silently dropped rather
// than published wrong.
const CALENDAR_QUARTER_END_BY_MONTHS = { 3: 'March 31', 6: 'June 30', 9: 'September 30', 12: 'December 31' };

// Returns a flat array of length itemCount, where result[idx] is the
// period-phrase object that real date column idx belongs to — evenly
// distributed when the count divides cleanly across periodPhrases (the
// common case, matches the original "N years each" assumption exactly),
// or proportionally by each phrase's own colspan when it doesn't (see
// parseTableColumns' own call site for the real iQIYI case this exists
// for). The proportional path requires EVERY phrase to carry a real
// colspan > 1 — externalPeriodPhrases (a phrase stated outside the table
// entirely, see extractStatement's own external-phrase handling) never
// has one, and guessing a split for those would be a real regression
// versus their current safe bail-out; requiring a genuine colspan keeps
// this fallback scoped to phrases that actually came from a table
// header cell. Returns null (caller treats as malformed, same as before
// this fallback existed) whenever a clean division or a valid
// proportional split isn't possible.
// Splits itemCount real items across groups weighted by each group's own
// colspan, either evenly (the common case) or proportionally when it
// doesn't divide cleanly. Returns null when neither a clean division nor a
// valid proportional split is possible (every weight must be > 1, and no
// resulting count may be <= 0). Factored out of allocateItemsToPhrases
// (behavior-preserving — identical checks/math, just returning counts
// instead of already-expanded items) so the currency-triple expansion in
// parseTableColumns below can reuse the exact same algorithm one level
// deeper in the same header hierarchy (currency columns -> date columns,
// same shape as date columns -> period phrases).
function proportionalCounts(itemCount, weights) {
  if (itemCount % weights.length === 0) {
    return weights.map(() => itemCount / weights.length);
  }
  if (weights.some((w) => !(w > 1))) return null;
  const total = weights.reduce((sum, w) => sum + w, 0);
  const counts = weights.map((w) => Math.round((w / total) * itemCount));
  counts[counts.length - 1] += itemCount - counts.reduce((a, b) => a + b, 0); // force exact total, absorb rounding drift in the last group
  if (counts.some((c) => c <= 0)) return null;
  return counts;
}

function allocateItemsToPhrases(itemCount, periodPhrases) {
  const counts = proportionalCounts(itemCount, periodPhrases.map((p) => p.colspan));
  if (!counts) return null;
  return periodPhrases.flatMap((phrase, idx) => Array(counts[idx]).fill(phrase));
}

function parseTableColumns($, table, externalPeriodPhrases = []) {
  const rows = $(table).find('tr').toArray();
  // A NINTH header shape, verified live: CPA's real cash-flow statement
  // states its period entirely OUTSIDE the <table> -- "Consolidated
  // statement of cash flows" / "For the six months ended" / "(In US$
  // thousands)" are three separate sibling <div>s sitting BEFORE the
  // table even starts, whose own first row is already the bare "2026 |
  // 2025" year pair. Every other phrase-based shape this function already
  // handles has the phrase living in one of the TABLE's own rows -- this
  // function only ever looks at $(table)'s own <tr>s, so it can never see
  // a phrase that lives in a preceding sibling <div> no matter how the
  // row-by-row search below is extended. The caller (extractStatement)
  // scans the elements between the heading and this table for exactly
  // this shape and passes the phrase(s) through here (see
  // findExternalPeriodPhrases' own comment for why this can be more than
  // one distinct phrase — SGHC's mid-year cash-flow caption states "for
  // the six months ended June 30, 2026" AND "and twelve months ended
  // December 31, 2025" as two separate phrases, each already carrying its
  // own date); seeding periodPhrases with them up front is equivalent to
  // the table having disclosed them in its own first row, so every
  // existing pendingMonthDays/dateCells branch below needs no further
  // change.
  let periodPhrases = externalPeriodPhrases.length ? externalPeriodPhrases : null;
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

    // An EIGHTH header shape, verified live: Copa Holdings (CPA) labels its
    // earnings-release comparison columns in compact "NQYY" quarter
    // notation -- "1Q26" | "1Q25" | "Change" | "4Q25" | "Change" -- a
    // year-over-year AND sequential-quarter comparison side by side in one
    // row, with "Change" (a % column, never a real value column) sitting
    // between real quarters. "Change" simply doesn't match this regex, so
    // it's already correctly excluded from the real column list without
    // any special-casing -- see parseDataRow's own %-column stripping for
    // how the VALUES on each row (which similarly interleave 3 real dollar
    // figures with 2 percent-change figures) get pared back down to just
    // the 3 matching these real columns.
    //
    // CPA's real Q2 header goes one step further and also appends a same-
    // row YTD cumulative pair -- "2Q26 | 2Q25 | Change% | 1Q26 | Change% |
    // YTD26 | YTD25 | Change%". Unlike "Change", a YTD value has no
    // adjacent "%" marker cell for parseDataRow to strip it by -- so
    // leaving "YTDyy" unrecognized (as if it were noise like "Change")
    // left 5 real numeric values per data row matching only 3 recognized
    // columns, and parseDataRow's exact-count check silently rejected
    // every row. Fix: recognize "YTDyy" as a real column too, typed by
    // the SAME quarter number as the row's own leading "NQyy" cell (the
    // filing's current reporting quarter -- e.g. "2Q26" tells us YTD26 is
    // cumulative Jan 1 - Jun 30 2026, the same end date as 2Q26 itself,
    // just 6 months long instead of 3; YTD through Q4 is naturally 12
    // months, i.e. the annual figure). Once typed with months > 3 for the
    // matching year, it's picked up automatically -- no other code change
    // needed -- by extractFromTable's existing cumulativeIdx pairing
    // (`c.months > 3 && c.year === targetEndYear`), giving CPA's own
    // quarter an extra same-document Check A reconciliation for free, via
    // the identical generic mechanism every other filer's 3mo+cumulative
    // row shape already uses.
    if (!periodPhrases) {
      const primaryQuarterMatch = cells.map((c) => c.text.trim().match(/^([1-4])Q(\d{2})$/)).find(Boolean);
      const primaryQuarterNum = primaryQuarterMatch ? Number(primaryQuarterMatch[1]) : null;
      const compactQuarterCells = cells
        .map((c) => {
          const text = c.text.trim();
          const q = text.match(/^([1-4])Q(\d{2})$/);
          if (q) return { months: 3, endMonthDay: CALENDAR_QUARTER_END_BY_MONTHS[Number(q[1]) * 3], year: `20${q[2]}` };
          const ytd = primaryQuarterNum ? text.match(/^YTD(\d{2})$/) : null;
          if (ytd) {
            return { months: primaryQuarterNum * 3, endMonthDay: CALENDAR_QUARTER_END_BY_MONTHS[primaryQuarterNum * 3], year: `20${ytd[1]}` };
          }
          return null;
        })
        .filter(Boolean);
      if (compactQuarterCells.length >= 1) {
        return { columns: compactQuarterCells, dataStartRowIdx: i + 1 };
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
        const parsed = phraseCells.map((c) => ({ ...parsePeriodPhrase(c.text), colspan: c.colspan })).filter((p) => p.months != null);
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
        if (process.env.DEBUG_CUMULATIVE_IDX) console.error('DEBUG periodPhrases-resolved', JSON.stringify(periodPhrases));
      }
      continue;
    }
    if (!pendingMonthDays) {
      const monthDayCells = cells.map((c) => parseBareMonthDayCell(c.text)).filter(Boolean);
      if (monthDayCells.length) {
        pendingMonthDays = monthDayCells;
        continue;
      }
    }

    // colspan carried alongside each successfully-parsed date (not re-
    // derived from `cells` by post-filter index, which would misalign the
    // moment any cell in the row fails to parse as a date) -- unused by
    // every existing code path below, only read by the currency-triple
    // expansion further down.
    const dateCells = cells
      .map((c) => {
        const d = parseDateHeaderCell(c.text);
        return d ? { ...d, colspan: c.colspan } : null;
      })
      .filter(Boolean);
    if (dateCells.length >= 2) {
      // Assigns each real date column to its period phrase — evenly when
      // possible (the common case), or proportionally by each phrase's own
      // colspan when a phrase genuinely spans more real columns than its
      // siblings. Verified live: iQIYI's real income statement has "Three
      // Months Ended" (colspan 10) spanning THREE real date columns (June
      // 30 2024, March 31 2025, June 30 2025 — a genuine same-document
      // current/sequential/YoY quarterly comparison) alongside "Six Months
      // Ended" (colspan 6) spanning only two (June 30 2024, June 30 2025) —
      // 5 real columns across 2 phrases, not evenly divisible, previously
      // rejected outright as malformed and silently blocking this table's
      // extraction entirely (likely the same shape for other major Chinese
      // ADRs using this same earnings-release convention — BABA/JD/PDD/NIO
      // among them). Deliberately NOT a colspan-GRID-POSITION
      // reconstruction (already tried and rejected elsewhere in this file
      // for exactly this class of table — see parseBareMonthDayCell's own
      // comment: real filers' rows have inconsistent leading/spacer cell
      // counts that break naive position alignment even when both rows sum
      // to the same total grid width) — this only uses each phrase's
      // colspan as a relative WEIGHT to split real columns proportionally,
      // which needs no spacer-cell alignment at all.
      const phraseByIdx = allocateItemsToPhrases(dateCells.length, periodPhrases);
      if (!phraseByIdx) continue; // can't sensibly assign — malformed, try a later row rather than guess

      // pendingMonthDays carries one of two real shapes: (a) one bare
      // month-day PER REAL DATE COLUMN already (iQIYI's case above — three
      // columns under "Three Months Ended" genuinely have three DIFFERENT
      // end-dates, so each is used directly, 1:1); or (b) the original,
      // more common shape — one month-day SHARED per phrase (e.g. a filer
      // whose "3mo"/"6mo" columns each share ONE period-end across all
      // their years) — expanded across every column belonging to that
      // phrase via the SAME phraseByIdx assignment used for duration.
      let monthDayByIdx = null;
      if (pendingMonthDays?.length === dateCells.length) {
        monthDayByIdx = pendingMonthDays;
      } else if (pendingMonthDays?.length === periodPhrases.length) {
        const monthDayByPhrase = new Map(periodPhrases.map((p, idx) => [p, pendingMonthDays[idx]]));
        monthDayByIdx = phraseByIdx.map((phrase) => monthDayByPhrase.get(phrase));
      }

      if (process.env.DEBUG_PARSE_TABLE_COLUMNS) {
        console.error('DEBUG parseTableColumns row', i, 'dateCells', JSON.stringify(dateCells), 'nextRow', i + 1 < rows.length ? JSON.stringify(nonEmptyCells($, rows[i + 1])) : 'N/A');
      }
      const columns = dateCells.map((date, idx) => {
        const phrase = phraseByIdx[idx];
        const pendingMonthDay = monthDayByIdx ? monthDayByIdx[idx] : null;
        // CPA's real cash-flow-statement header, verified live: "For the six
        // months ended" sits on its own row with no trailing date at all
        // ("ended" is followed by nothing, not "ended June 30"), and the
        // ONLY other header row is a bare "2026 | 2025" year pair -- no
        // month/day ever appears anywhere in this header, unlike every
        // other phrase-based filer already handled (which either states the
        // date inline in the phrase itself, or carries a separate bare-
        // month-day row). Without a last-resort fallback here, endMonthDay
        // stays null for every column and this whole table (and every
        // concept it holds -- OCF/capex here) is silently unextractable.
        // Falling back to the phrase's own stated duration's standard
        // calendar-aligned end (3mo->Mar 31, 6mo->Jun 30, etc.) is safe to
        // guess here specifically because it's the LAST option tried, after
        // every stronger real-date source already failed -- a wrong guess
        // for a non-calendar fiscal year just can't match any real annual
        // XBRL date and fails Check A/B/C reconciliation harmlessly, same
        // as any other unverified candidate in this file.
        const endMonthDay = date.monthDay || pendingMonthDay || phrase.endMonthDay || CALENDAR_QUARTER_END_BY_MONTHS[phrase.months];
        return endMonthDay ? { months: phrase.months, endMonthDay, year: date.year } : null;
      });
      if (columns.some((c) => !c)) continue; // neither row carries a date for some column — bail on this row, try the next

      // Currency-triple expansion — see CURRENCY_CODE_CELL's own comment.
      // Only the row IMMEDIATELY following the date row is checked (real
      // filers always place the currency row directly under it, never with
      // an intervening row), and only when EVERY cell in it is a bare
      // currency code (never fires on an ordinary label/data row) with MORE
      // of them than date columns (confirming a genuine undercounted split,
      // not a coincidental currency-shaped label elsewhere).
      const nextRowCells = i + 1 < rows.length ? nonEmptyCells($, rows[i + 1]) : [];
      if (nextRowCells.length > columns.length && nextRowCells.every((c) => CURRENCY_CODE_CELL.test(c.text))) {
        const distinctCurrencies = new Set(nextRowCells.map((c) => c.text.toUpperCase()));
        const expandCounts =
          distinctCurrencies.size >= 2 ? proportionalCounts(nextRowCells.length, dateCells.map((d) => d.colspan || 1)) : null;
        if (expandCounts) {
          const expandedColumns = [];
          const keepIndices = [];
          let cursor = 0;
          for (let colIdx = 0; colIdx < columns.length; colIdx++) {
            for (let k = 0; k < expandCounts[colIdx]; k++) {
              const isConvenience = CONVENIENCE_TRANSLATION_CURRENCY.test(nextRowCells[cursor].text);
              expandedColumns.push(columns[colIdx]);
              if (!isConvenience) keepIndices.push(cursor);
              cursor++;
            }
          }
          // Degenerate case: every sub-column is USD (a foreign issuer
          // whose functional/native currency actually IS USD already) —
          // nothing real to drop, keep every expanded column rather than
          // discarding all real data.
          const finalKeepIndices = keepIndices.length ? keepIndices : expandedColumns.map((_, idx) => idx);
          return {
            columns: finalKeepIndices.map((idx) => expandedColumns[idx]),
            dataStartRowIdx: i + 1,
            rawColumnCount: nextRowCells.length,
            valueIndices: finalKeepIndices,
          };
        }
      }

      // Currency GROUP-LABEL row — see UNIT_CURRENCY_LABEL_CELL's own
      // comment for how this differs from the currency-triple expansion
      // just above (fewer cells than date columns, using colspan to cover
      // a group, rather than more cells needing expansion). columns.length
      // is already correct here — this only ever DROPS columns, never
      // expands them.
      if (
        nextRowCells.length &&
        nextRowCells.length < columns.length &&
        nextRowCells.every((c) => UNIT_CURRENCY_LABEL_CELL.test(c.text)) &&
        nextRowCells.reduce((sum, c) => sum + (c.colspan || 1), 0) === columns.length
      ) {
        const keepIndices = [];
        let cursor = 0;
        for (const cell of nextRowCells) {
          const span = cell.colspan || 1;
          const isConvenience = CONVENIENCE_TRANSLATION_CURRENCY.test(cell.text.match(UNIT_CURRENCY_LABEL_CELL)[1]);
          for (let k = 0; k < span; k++) {
            if (!isConvenience) keepIndices.push(cursor);
            cursor++;
          }
        }
        // Degenerate case: every group is USD — nothing real to drop.
        const finalKeepIndices = keepIndices.length ? keepIndices : columns.map((_, idx) => idx);
        if (process.env.DEBUG_PARSE_TABLE_COLUMNS) {
          console.error('DEBUG unit-currency-group MATCHED', JSON.stringify({ finalKeepIndices, columns }));
        }
        if (finalKeepIndices.length < columns.length) {
          return {
            columns: finalKeepIndices.map((idx) => columns[idx]),
            dataStartRowIdx: i + 1,
            rawColumnCount: columns.length,
            valueIndices: finalKeepIndices,
          };
        }
      }

      // A TWELFTH header shape, verified live: TSM (Taiwan Semiconductor)'s
      // real "Consolidated Statements of Comprehensive Income" interleaves
      // a "% of revenue" column between periods -- a sub-header row reading
      // "Amount" | "%" | "Amount" | "%" sitting directly under the bare-year
      // row, doubling the raw cell count per date column without any
      // currency marker at all (so neither currency check above fires).
      // Every data row then carries a matching value+percent pair per
      // period (e.g. "$839,253,664" | "100" for 2025's Net Revenue -- "100"
      // meaning "100% of revenue", not a second currency or a real figure).
      // Reuses the exact same rawColumnCount/valueIndices mechanism as the
      // currency-triple expansion above, just keeping each pair's "Amount"
      // slot and dropping its "%" one.
      if (
        nextRowCells.length === columns.length * 2 &&
        nextRowCells.every((c, idx) => (idx % 2 === 0 ? /^Amounts?$/i.test(c.text) : /^%$/.test(c.text)))
      ) {
        const keepIndices = columns.map((_, colIdx) => colIdx * 2);
        return {
          columns,
          dataStartRowIdx: i + 2,
          rawColumnCount: nextRowCells.length,
          valueIndices: keepIndices,
        };
      }

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
    // A "%"/"%)" marker cell immediately following a value means that
    // value was itself a percent-change figure (a year-over-year or
    // sequential-quarter "Change" column, e.g. Copa Holdings/CPA's real
    // earnings-release rows: "1,004,173 | 859,025 | 16.9 | % | 913,623 |
    // 9.9 | %" -- three real dollar values interleaved with two % changes).
    // Discard the value it's attached to and move on, rather than either
    // bailing outright (parseNumericCell("%") is null, which used to hit
    // the "malformed" return below before this row's real values were ever
    // reached) or keeping a percent as if it were a real dollar figure.
    if (/^%\)?$/.test(cells[i].text.trim())) {
      valueCandidates.pop();
      continue;
    }
    const val = parseNumericCell(cells[i].text);
    if (val === null) return null; // non-numeric cell after values started — malformed, bail
    valueCandidates.push({ raw: cells[i].text, val });
  }
  let values = valueCandidates;
  if (values.length === columnCount + 1) {
    const [first, ...rest] = values;
    // A single footnote ref ("2"), a comma-separated list of them ("2, 8"),
    // or one wrapped in parentheses ("(4)") -- verified live for two real
    // shapes: NTR's "Sales" row reads `Sales | 2, 8 | 6,046 | 5,100` (two
    // note numbers in one cell), and QGEN's "Net sales" row reads
    // `Net sales | (4) | 535,040 | ...` (a single note number in
    // parentheses, which parseNumericCell's own negative-number handling
    // turns into the spurious value -4). Both silently discarded the whole
    // row as malformed since one extra value no longer matched columnCount.
    // The mandatory `\s+` before each comma-continuation is what keeps this
    // from also matching a real thousands-grouped value like "6,046" (no
    // space after its comma); the optional wrapping parens are why a real
    // negative value like "(1,234)" still correctly fails this test too
    // (no space after ITS comma either) -- a real number here must never be
    // misread as a footnote reference.
    const looksLikeFootnoteRef = /^\(?\d{1,3}(,\s+\d{1,3})*\)?$/.test(first.raw.trim());
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

// DEFAULT concepts for which a cumulative-only (H1/9mo) column is an
// acceptable substitute for a missing 3-month one -- see the
// usingCumulativeOnly fallback below. Used only when a caller doesn't pass
// its own per-ticker Set (see extractQuarterlyFactsFromFilings's
// `cumulativeFallbackConcepts` parameter) -- kept narrow to ocf/capex here
// as a safe fallback for any caller that hasn't been updated to compute a
// real per-ticker Set.
//
// The real, general rule (why this can't just be a bigger static allow-
// list) -- verified live for IMPP: its XBRL already carries real
// H1-duration facts for revenue/netIncome/ebit/pretaxIncome that
// dedupeAndClassify already knows how to handle correctly on its own. A
// redundant, differently-shaped text-extracted duplicate of that SAME H1
// period won a "most recently filed" tiebreak over the XBRL original and
// broke whatever made the existing XBRL-native handling work, even though
// the duplicate's own value was identical. ocf/capex were safe to blanket-
// allow only because the motivating case (ASC) had no equivalent XBRL
// coverage at all -- nothing for a duplicate to conflict with. Extending
// that same reasoning to revenue/netIncome/etc. for OTHER tickers (e.g.
// GSL, a Marine-industry filer whose XBRL is 100% annual-only, zero
// quarterly/H1 coverage of any kind) requires knowing, per ticker per
// concept, whether real non-annual XBRL already exists -- exactly what
// callers now compute and pass via `cumulativeFallbackConcepts`.
const CUMULATIVE_FALLBACK_CONCEPTS = new Set(['ocf', 'capex']);

// Only recent XBRL facts count as a real conflict risk -- verified live:
// ASC's capex XBRL has real non-annual (quarterly/H1/9mo) facts from
// 2015-2019 (an old tagging convention it no longer uses), which would
// otherwise permanently mark capex "unsafe" for ASC even though today's
// text-extraction only ever scans MAX_FILINGS_TO_SCAN's most recent
// filings and could never produce a period old enough to duplicate those.
// 3 years comfortably covers that scan window (filers file 2-4 6-Ks/year)
// without reaching back into unrelated old tagging eras.
const CUMULATIVE_FALLBACK_RECENCY_YEARS = 3;

// Computes the real, per-ticker `cumulativeFallbackConcepts` Set --
// concepts safe to trust a cumulative-only (H1/9mo) text-extracted column
// for, because THIS ticker's own raw XBRL has zero RECENT non-annual
// (quarterly/H1/9mo) facts for that concept to conflict with.
// `rawFactsByConcept` is `{ [concept]: Array<{start, end}> }` -- the SAME
// raw fact arrays (extractFactSeries's output, before dedupeAndClassify)
// every caller already has in scope; pass an entry (even an empty array)
// for every concept being requested, since a concept missing from this
// object is never added to the returned Set (never marked safe).
function computeCumulativeFallbackConcepts(rawFactsByConcept) {
  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - CUMULATIVE_FALLBACK_RECENCY_YEARS);
  const safe = new Set();
  for (const [concept, facts] of Object.entries(rawFactsByConcept || {})) {
    const hasRecentNonAnnual = (facts || []).some((f) => {
      if (!f.start || !f.end) return false;
      if (new Date(f.end) < cutoff) return false;
      const days = (new Date(f.end) - new Date(f.start)) / (1000 * 60 * 60 * 24);
      // Only the exact duration ranges dedupeAndClassify itself buckets as
      // quarterly/h1/q3ytd -- verified live: ASC has a real, recently-
      // filed but 30-day-long capex fact (a stub period, not a genuine
      // quarter/H1/9mo), which doesn't fall in ANY of dedupeAndClassify's
      // recognized ranges and so can never actually be published or
      // collide with a text-extracted duplicate -- a blanket "< 365 days"
      // check flagged it as a conflict risk anyway, incorrectly blocking
      // ASC's real, currently-working capex extraction.
      return (days >= 80 && days <= 100) || (days >= 170 && days <= 200) || (days >= 260 && days <= 300);
    });
    if (!hasRecentNonAnnual) safe.add(concept);
  }
  return safe;
}

// Resolves a list of candidate rows that all matched the same concept down
// to either a single winning candidate or (for capex/debt, which can
// genuinely split across multiple real, non-overlapping lines with no
// single "Total" row -- see the capex/debt LABEL_ALIASES comments) the
// full surviving candidate set for the CALLER to sum (each caller's
// candidates carry a different value shape -- extractFromTable's have
// value3mo+valueCumulative, extractFromInstantTable's have a single value
// -- so summation itself stays caller-specific). Returns null if still
// genuinely ambiguous (0 or 2+ candidates after every tiebreak).
// `valueKey` names which field represents each candidate's numeric value,
// for the repeat-match dedup only. Shared, behavior-preserving extraction
// of logic previously duplicated (with slight variations) between
// extractFromTable and extractFromInstantTable.
function resolveConceptCandidates(list, concept, valueKey) {
  const distinct = [];
  for (const c of list) if (!distinct.some((d) => d[valueKey] === c[valueKey])) distinct.push(c);
  if (distinct.length === 1) return { winner: distinct[0] };

  // A repeat match is only a genuine conflict if its value actually
  // DIFFERS from an earlier one — verified live: Eldorado Gold (EGO)
  // repeats "Net earnings for the period" verbatim, once as the
  // statement's own subtotal and again after the shareholders/non-
  // controlling-interest attribution breakdown, both carrying the
  // IDENTICAL real figure. Treating any second label match as
  // automatically ambiguous was silently dropping a large share of real,
  // unambiguous matches whenever a filer's presentation repeats a
  // subtotal this way (a common pattern, not specific to EGO).
  //
  // Multiple genuinely different values for the same concept — verified
  // live: DEFT breaks revenue into several real sub-lines that all match
  // the broad revenue keyword alongside the statement's own "Total
  // revenues" line — a universal accounting-statement convention (sub-
  // items roll up into one "Total" row). When exactly one candidate is
  // unambiguously a total line, prefer it over the sub-items rather than
  // dropping the concept entirely.
  const totalMatches = distinct.filter((d) => /^total\b/i.test(d.label.trim()));
  if (totalMatches.length === 1) return { winner: totalMatches[0] };

  // Still tied — for netIncome specifically, DEFT also discloses a
  // separate "Net income for the period after taxes" alongside "Net
  // income and comprehensive income for the period" (the latter folds in
  // OCI items like currency translation, a genuinely different figure). A
  // PREFERENCE, not an exclude: a filer with no separate net-income line
  // at all (its only bottom-line total literally named "...and
  // comprehensive income...") never reaches this branch (already resolved
  // above via the single-candidate or total-match case).
  if (concept === 'netIncome') {
    const nonComprehensive = distinct.filter((d) => !/comprehensive/i.test(d.label));
    if (nonComprehensive.length === 1) return { winner: nonComprehensive[0] };
    // "attributable to" (the parent/ordinary-shareholders figure, excluding
    // non-controlling interests) preferred over a plain whole-entity total
    // -- verified live: ZTO Express (ZTO) shows both "Net income" (the
    // whole-entity figure) and "Net income attributable to ZTO Express
    // (Cayman) Inc." / "...attributable to ordinary shareholders" (the
    // same real, smaller figure under two labels, already collapsed to one
    // distinct candidate by the value-based dedup above) as two genuinely
    // different values in the same statement. The parent-attributable
    // figure is the one every profitMargin/EPS-style ratio conventionally
    // means by "net income" (NCI's share isn't available to ordinary
    // shareholders) -- a universal pattern for any filer with a
    // non-wholly-owned subsidiary, not specific to ZTO. The exclude list
    // above already drops an "...attributable to non-controlling
    // interests" row before it ever reaches here; the negative lookahead
    // is just a second, cheap guard against the same thing.
    const attributableToParent = distinct.filter((d) => /attributable to (?!(non|minority))/i.test(d.label));
    if (attributableToParent.length === 1) return { winner: attributableToParent[0] };
  }
  // revenue specifically: a filer can break revenue into several
  // sub-lines that don't roll up into a "Total ..."-prefixed row -- verified
  // live: Euroholdings (EHLD) shows "Time charter revenue" and "Voyage
  // charter revenue" as real sub-items, then subtracts commissions down to
  // "Net revenues" as its own real subtotal line, never labeled "Total
  // revenues". Same shape as ocf's "net cash" preference right below --
  // prefer whichever candidate's label starts with "net revenue(s)" when
  // exactly one does.
  if (concept === 'revenue') {
    const netRevenue = distinct.filter((d) => /^net\s+revenues?\b/i.test(d.label.trim()));
    if (netRevenue.length === 1) return { winner: netRevenue[0] };
  }
  // ocf specifically: a filer can show a pre-tax operating cash flow
  // SUBTOTAL as its own line before subtracting taxes paid down to the
  // real bottom-line figure -- verified live: IAMGOLD (IAG) shows both
  // "Cash from operating activities, before income taxes paid" AND "Net
  // cash from operating activities" as genuinely different real values in
  // the same statement, neither prefixed "Total". The second is the
  // actual OCF figure every other source means by the term -- prefer
  // whichever candidate's label starts with "net cash" when exactly one
  // does.
  if (concept === 'ocf') {
    const netCash = distinct.filter((d) => /^net\s+cash\b/i.test(d.label.trim()));
    if (netCash.length === 1) return { winner: netCash[0] };
  }
  // shares specifically: "basic" and "diluted" are both real, genuinely
  // different values, both commonly disclosed as separate lines -- prefer
  // basic when both are present, matching SHARES_CONCEPTS' own existing
  // preference order (WeightedAverageNumberOfSharesOutstandingBasic listed
  // before ...Diluted) in generateForeignFilingsCache.js/
  // generateForeignPfcfCache.js -- basic is the convention this codebase
  // already uses for the P/FCF-per-share calculation.
  if (concept === 'shares') {
    const basicOnly = distinct.filter((d) => /\bbasic\b/i.test(d.label));
    if (basicOnly.length === 1) return { winner: basicOnly[0] };
  }
  // capex/debt specifically: unlike revenue/netIncome (one bottom-line
  // total rolling up sub-items), a filer can report either as several
  // genuinely separate, non-overlapping lines with no single "Total" row
  // at all. Signaled here rather than summed here, since safe to attempt
  // because the sum still has to pass the SAME downstream reconciliation
  // as any other extracted point before it's ever trusted; an accidental/
  // wrong sum simply fails to verify and gets dropped exactly like a bad
  // single-row match would.
  if (concept === 'capex' || concept === 'debt') return { sum: distinct };

  // Any other shape (0 or 2+ candidates after every tiebreak) stays
  // genuinely ambiguous.
  return null;
}

function extractFromTable($, table, targetEndYear, aliasMap, cumulativeFallbackConcepts = CUMULATIVE_FALLBACK_CONCEPTS, externalPeriodPhrases = []) {
  const parsed = parseTableColumns($, table, externalPeriodPhrases);
  if (!parsed) return null;
  const { columns, dataStartRowIdx, rawColumnCount, valueIndices } = parsed;
  // rawColumnCount/valueIndices are only ever set by parseTableColumns'
  // currency-triple expansion (see CURRENCY_CODE_CELL) -- absent for every
  // other header shape, where this is exactly the pre-existing behavior
  // (parseDataRow validated against columns.length, values used as-is).
  const parsedRowColumnCount = rawColumnCount ?? columns.length;

  const targetIdx3mo = columns.findIndex((c) => c.months === 3 && c.year === targetEndYear);
  // Same fiscal year's cumulative (6mo/9mo) column, if this table has one —
  // normally just used for the within-filing reconciliation check below.
  const cumulativeIdx = columns.findIndex((c) => c.months > 3 && c.year === targetEndYear);
  if (process.env.DEBUG_CUMULATIVE_IDX) console.error('DEBUG cumulativeIdx-trace', 'targetEndYear', JSON.stringify(targetEndYear), 'columns', JSON.stringify(columns), 'targetIdx3mo', targetIdx3mo, 'cumulativeIdx', cumulativeIdx);
  const eligibleForCumulativeFallback = Object.keys(aliasMap).every((c) => cumulativeFallbackConcepts.has(c));
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
  // Most recent header-only row's own text (a row with no numeric values --
  // parseDataRow returns null for it below) -- disambiguates a BARE
  // "Basic"/"Diluted" subrow, which carries no meaning on its own. Verified
  // live: CNI (Canadian National Railway) discloses "Weighted-average
  // number of shares (Note 7)" as its own header-only row immediately
  // followed by separate "Basic"/"Diluted" data rows -- structurally
  // IDENTICAL to its neighboring "Earnings per share (Note 7)" section,
  // whose own "Basic"/"Diluted" subrows hold the $ EPS figures instead.
  // Neither subrow's bare label alone says which one it is.
  let pendingSectionLabel = null;
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
    const row = parseDataRow(cells, parsedRowColumnCount);
    if (!row) {
      if (rowText.trim()) pendingSectionLabel = rowText.trim();
      continue;
    }
    if (valueIndices) row.values = valueIndices.map((idx) => row.values[idx]);
    // A bare "Basic"/"Diluted" label means nothing by itself -- match
    // against it PREFIXED with the most recent header-only row's text
    // instead (see pendingSectionLabel's own comment above), so CNI's real
    // "Weighted-average number of shares" + "Basic" combination matches the
    // shares concept while the neighboring "Earnings per share" + "Basic"
    // combination correctly does NOT (it has no "weighted" in it at all).
    // The ORIGINAL bare label is still what gets stored on the candidate
    // below -- resolveConceptCandidates' own basic/diluted tiebreak already
    // depends on that exact bare wording.
    const effectiveLabel = /^(basic|diluted)$/i.test(row.label.trim()) && pendingSectionLabel ? `${pendingSectionLabel} ${row.label}` : row.label;
    for (const concept of Object.keys(aliasMap)) {
      if (!matchesConcept(effectiveLabel, concept)) continue;
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
    const resolved = resolveConceptCandidates(list, concept, 'value3mo');
    if (process.env.DEBUG_FILING_EXTRACT_CANDIDATES) console.error('DEBUG candidates', concept, JSON.stringify(list), '-> resolved:', JSON.stringify(resolved));
    if (!resolved) continue;
    if (resolved.winner) { results[concept] = resolved.winner; continue; }
    // capex-only sum (debt has no value3mo/valueCumulative shape — that's
    // extractFromInstantTable's concept) -- see resolveConceptCandidates'
    // own comment for why this is safe to attempt.
    if (resolved.sum && concept === 'capex') {
      const value3mo = resolved.sum.reduce((sum, d) => sum + d.value3mo, 0);
      const cumulativeParts = resolved.sum.map((d) => d.valueCumulative);
      const valueCumulative = cumulativeParts.every((v) => v != null) ? cumulativeParts.reduce((sum, v) => sum + v, 0) : null;
      results[concept] = { label: resolved.sum.map((d) => d.label).join(' + '), value3mo, valueCumulative };
    }
  }
  return Object.keys(results).length ? { period: targetPeriod, facts: results } : null;
}

// ---------------------------------------------------------------------------
// 20-F annual extraction — unlike extractFromTable above (which targets ONE
// specific quarter), a 20-F's own comparative table already carries 2-3
// full fiscal years in ONE table, all independently useful, so this returns
// one result PER ANNUAL COLUMN rather than a single target period (same
// "every column is useful" shape as extractFromInstantTable). Kept as a
// separate sibling function rather than a modification of extractFromTable
// -- reuses parseTableColumns/matchesConcept/resolveConceptCandidates, but
// the "collect every annual column at once, plus each section's own
// disclosed subtotal" shape is different enough that folding it into the
// already-heavily-tested interim-quarter function risked destabilizing it
// for no benefit.
//
// A real subtotal row ("Net cash used in investing activities", "Net cash
// provided by operating activities", etc.) -- deliberately narrow (starts
// with "net cash"/"net increase"/"net decrease", names one of the three
// section words) so a genuine subtotal is never confused with an ordinary
// line item. Used for "Check D" below: if every numeric row assigned to a
// section sums to that section's OWN disclosed subtotal, every section-
// restricted concept extracted from that column is corroborated by the
// document's own internal arithmetic, without needing a second filing to
// agree. Verified live against DHT's real 20-F: investing-activities rows
// for FY2025 (-111,125 + -198,511 + 143,521 + 0 + -306) sum to exactly
// -166,421, matching that column's own disclosed "Net cash used in
// investing activities" subtotal to the dollar.
const SECTION_SUBTOTAL_PATTERN = /^net (cash|increase|decrease)\b.*(operating|investing|financing) activities/i;

// SEC's auto-rendered R-files state their own unit convention directly in
// the table's own header caption -- e.g. "Consolidated Statement of Cash
// Flow - USD ($) $ in Thousands" -- rather than requiring statistical
// inference the way detectScaleMultiplier's 6-K-path comparison does.
// Deliberately NOT reusing detectScaleMultiplier here: its algorithm sums
// MULTIPLE same-year points to approximate a fraction of a real annual
// XBRL total (built for quarterly-vs-annual comparison), which doesn't
// apply when the points ARE the annual values themselves, AND no reliable
// same-concept-same-year anchor exists for the very years this path exists
// to recover (verified live: DHT's real capex XBRL anchor only covers
// FY2015-2021, under a different, narrower concept than the gap years
// FY2022+ this path recovers -- nothing to compare against even if the
// shapes did line up). Verified live against two real filers: DHT's own
// caption reads "...$ in Thousands" (its real capex is ~$100-300M/year,
// confirming the displayed ~$100-300K-looking figures needed x1000);
// IMPP's caption has no unit qualifier at all (raw dollars, needs no
// scaling) -- both handled by the same simple text check.
function detectTableScale($, table) {
  // Checks the first THREE rows, not just the first -- verified live:
  // ITRN's own balance sheet puts its "(In thousands)" caption in its
  // SECOND row (row 1 is just the statement title, row 2 the units
  // caption, row 3+ the real column headers/dates), a common enough
  // layout that checking only row 1 silently missed the scale entirely,
  // leaving a real $224,486,000 equity figure as a bare, 1000x-too-small
  // "224,486" -- which then corrupted ROIC (and anything else dividing by
  // it) into an absurd value. Three rows is generous enough to catch a
  // title+caption pair or even title+blank+caption while still being
  // comfortably before any real header row's own test for the column-
  // phrase shapes.
  const headerText = $(table)
    .find('tr')
    .slice(0, 3)
    .map((_, tr) => $(tr).text())
    .get()
    .join(' ');
  if (/in thousands/i.test(headerText)) return 1000;
  if (/in millions/i.test(headerText)) return 1000000;
  return 1;
}

function extractAllAnnualColumnsFromTable($, table, aliasMap) {
  const parsed = parseTableColumns($, table);
  if (!parsed) return [];
  const { columns, dataStartRowIdx, rawColumnCount, valueIndices } = parsed;
  // See extractFromTable's identical handling — only set by
  // parseTableColumns' currency-triple expansion, a no-op otherwise.
  const parsedRowColumnCount = rawColumnCount ?? columns.length;
  const annualIdxs = columns.map((c, i) => (c.months === 12 ? i : -1)).filter((i) => i !== -1);
  if (!annualIdxs.length) return [];
  const scale = detectTableScale($, table);

  const rows = $(table).find('tr').toArray();
  const candidatesByColumn = annualIdxs.map(() => ({})); // concept -> [{label, value}]
  const sectionDataByColumn = annualIdxs.map(() => ({})); // section -> {sum, subtotal}
  let currentSection = null;
  for (let i = dataStartRowIdx; i < rows.length; i++) {
    const cells = nonEmptyCells($, rows[i]);
    if (!cells.length) continue;
    const rowText = cells.map((c) => c.text).join(' ');
    const isSubtotalRow = SECTION_SUBTOTAL_PATTERN.test(rowText);
    // Same section-tracking as extractFromTable -- see its own comment for
    // why this runs on raw cell text, independent of whether the row ends
    // up a real parseable data row at all. A subtotal row names its own
    // section too (e.g. "...investing activities") but must NOT re-trigger
    // this branch -- it's concluding the section, not opening a new one.
    if (!isSubtotalRow) {
      if (/operating activities/i.test(rowText)) currentSection = 'operating';
      else if (/investing activities/i.test(rowText)) currentSection = 'investing';
      else if (/financing activities/i.test(rowText)) currentSection = 'financing';
    }
    const row = parseDataRow(cells, parsedRowColumnCount);
    if (!row) continue;
    if (valueIndices) row.values = valueIndices.map((idx) => row.values[idx]);
    if (scale !== 1) row.values = row.values.map((v) => v * scale);

    if (isSubtotalRow && currentSection) {
      for (let ci = 0; ci < annualIdxs.length; ci++) {
        const data = (sectionDataByColumn[ci][currentSection] = sectionDataByColumn[ci][currentSection] || { sum: 0, subtotal: null });
        data.subtotal = row.values[annualIdxs[ci]];
      }
      // Falls through to the concept-matching loop below (no `continue`) --
      // verified live: ASR's real operating-activities subtotal row IS
      // itself the real ocf value ("Net cash flows generated from
      // operating activities"), standard cash-flow-statement presentation
      // for any filer whose OCF concept isn't section-restricted (unlike
      // capex, which is usually one or a few specific investing-activity
      // line ITEMS, never the investing-activities subtotal as a whole --
      // this was previously unconditionally excluding every subtotal row
      // from candidate-matching, silently losing ocf/fcfMargin for any
      // filer whose real 20-F discloses no separate, differently-worded
      // line beyond this exact subtotal). Still excluded from the
      // section-sum accumulation just below -- that sum is specifically
      // for reconciling the itemized ADJUSTMENT lines against this
      // subtotal (Check D), not for folding the subtotal into its own sum.
    } else if (currentSection) {
      for (let ci = 0; ci < annualIdxs.length; ci++) {
        const data = (sectionDataByColumn[ci][currentSection] = sectionDataByColumn[ci][currentSection] || { sum: 0, subtotal: null });
        data.sum += row.values[annualIdxs[ci]];
      }
    }

    for (const concept of Object.keys(aliasMap)) {
      if (!matchesConcept(row.label, concept)) continue;
      const requiredSection = SECTION_RESTRICTED_CONCEPTS[concept];
      if (requiredSection && currentSection !== requiredSection) continue;
      for (let ci = 0; ci < annualIdxs.length; ci++) {
        (candidatesByColumn[ci][concept] = candidatesByColumn[ci][concept] || []).push({ label: row.label, value: row.values[annualIdxs[ci]] });
      }
    }
  }

  const out = [];
  for (let ci = 0; ci < annualIdxs.length; ci++) {
    const results = {};
    for (const [concept, list] of Object.entries(candidatesByColumn[ci])) {
      const resolved = resolveConceptCandidates(list, concept, 'value');
      if (!resolved) continue;
      if (resolved.winner) { results[concept] = resolved.winner; continue; }
      if (resolved.sum && concept === 'capex') {
        results[concept] = { label: resolved.sum.map((d) => d.label).join(' + '), value: resolved.sum.reduce((sum, d) => sum + d.value, 0) };
      }
    }
    if (!Object.keys(results).length) continue;
    // Check D eligibility -- only meaningful for section-restricted
    // concepts (currently just capex), where the section boundary is
    // already well-defined; an unrestricted concept has no single section
    // to check a subtotal against.
    const sectionVerifiedConcepts = new Set();
    for (const concept of Object.keys(results)) {
      const section = SECTION_RESTRICTED_CONCEPTS[concept];
      if (!section) continue;
      const data = sectionDataByColumn[ci][section];
      if (!data || data.subtotal == null) continue;
      const diff = Math.abs(data.sum - data.subtotal) / Math.abs(data.subtotal || 1);
      if (diff <= RECONCILE_TOLERANCE) sectionVerifiedConcepts.add(concept);
    }
    out.push({ period: columns[annualIdxs[ci]], facts: results, sectionVerifiedConcepts });
  }
  return out;
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
// Detects a trailing "Change" + "%" pair of EXTRA header cells beyond the
// real date columns -- verified live: PAC (Grupo Aeroportuario del
// Pacifico)'s real balance sheet headers each row "2025 | 2026 | Change |
// %", where every data row then carries a matching extra ABSOLUTE
// difference value immediately before its own "%" cell (e.g. "16,227,819
// | 23,185,136 | 6,957,317 | 42.9 | %" for Cash and cash equivalents) --
// unlike the duration-side CPA precedent (a bare percent only, no
// absolute-difference number), parseDataRow's existing single-value %-pop
// isn't enough here: it correctly drops the percent but leaves the
// absolute-difference value behind, overcounting every row by exactly 1
// and silently rejecting 100% of this table's rows as malformed (values.
// length never equals columnCount). Mirrors the duration-side currency-
// triple's own rawColumnCount/valueIndices mechanism -- kept to this one
// specific, verified 2-extra-cell shape rather than a speculative general
// rule, since an unindicated real reason columnCount might differ (e.g. a
// genuine third real date column) must never be silently discarded.
function detectTrailingChangeColumns(headerCells, realColumnCount) {
  if (headerCells.length !== realColumnCount + 2) return null;
  const [change, pct] = headerCells.slice(realColumnCount);
  if (!/^change$/i.test(change.text) || !/^%$/.test(pct.text)) return null;
  // The expected POST-popping value count, not the header's own raw cell
  // count -- parseDataRow's existing single-value "%"-marker pop already
  // consumes the computed percent NUMBER and its own "%" sign by itself
  // (same mechanism the duration-side CPA precedent relies on), so the
  // header's 2 extra cells ("Change" + "%") collapse to just ONE lingering
  // numeric value per row (the absolute difference itself, which nothing
  // else marks for removal) -- verified live: PAC's "Cash and cash
  // equivalents" row is "16,227,819 | 23,185,136 | 6,957,317 | 42.9 | %"
  // (5 raw cells), which parseDataRow's own popping already reduces to 3
  // values before this function's columnCount check ever sees it, not 4.
  return { rawColumnCount: realColumnCount + 1, valueIndices: Array.from({ length: realColumnCount }, (_, idx) => idx) };
}

function parseInstantTableColumns($, table, externalColumnDates = null, externalBareMonthDay = null) {
  const rows = $(table).find('tr').toArray();
  for (let i = 0; i < rows.length; i++) {
    const cells = nonEmptyCells($, rows[i]);
    const dateCells = cells.map((c) => parseDateHeaderCell(c.text)).filter((d) => d && d.monthDay);
    if (dateCells.length >= 2) {
      const columns = dateCells.map((d) => ({ endMonthDay: d.monthDay, year: d.year }));
      const trailing = detectTrailingChangeColumns(cells, columns.length);
      return trailing ? { columns, dataStartRowIdx: i + 1, ...trailing } : { columns, dataStartRowIdx: i + 1 };
    }
  }
  // A bare-year-only header row ("2025 | 2026 | Change | %", no month/day
  // of its own -- isYearCell's branch of parseDateHeaderCell always
  // returns monthDay:null, so the loop above can never resolve it),
  // combined with a caption that states the shared month/day WITHOUT a
  // year of its own ("as of March 31 (in thousands of pesos)" -- both
  // comparison years share the same fiscal quarter-end, so PAC's filer
  // states the day just once). Neither source alone carries a complete
  // date; externalColumnDates (below) requires a FULL date with year and
  // finds nothing in a caption like this either. Tried only after both
  // stronger sources above have already failed.
  if (externalBareMonthDay) {
    for (let i = 0; i < rows.length; i++) {
      const cells = nonEmptyCells($, rows[i]);
      const yearCells = cells.filter((c) => isYearCell(c.text));
      if (yearCells.length >= 2) {
        const columns = yearCells.map((c) => ({ endMonthDay: externalBareMonthDay, year: extractYear(c.text) }));
        const trailing = detectTrailingChangeColumns(cells, columns.length);
        return trailing ? { columns, dataStartRowIdx: i + 1, ...trailing } : { columns, dataStartRowIdx: i + 1 };
      }
    }
  }
  // Fallback shape, verified live: SGHC's real balance-sheet caption states
  // both dates entirely in prose OUTSIDE the table -- "as at June 30, 2026"
  // and "and December 31, 2025 in $ millions" sit in two sibling <font>
  // leaves above the table, which itself is left with just a bare
  // "2026 | 2025" year-pair header row. Every date cell above has
  // d.monthDay === null for a bare year (isYearCell branch of
  // parseDateHeaderCell), so the loop above can never resolve real column
  // dates from the table alone -- same shape as parseTableColumns' own
  // external-period-phrase fix, applied here to instant/balance-sheet
  // columns instead of duration columns. The caller (extractInstantStatement)
  // gathers these dates from the heading-to-table gap and passes them
  // through; matched here by finding the row whose bare-year-cell COUNT
  // equals the hint's length (position-order pairing, same convention as
  // every other multi-column header shape in this file).
  if (externalColumnDates && externalColumnDates.length >= 2) {
    for (let i = 0; i < rows.length; i++) {
      const cells = nonEmptyCells($, rows[i]);
      const yearCells = cells.filter((c) => isYearCell(c.text));
      if (yearCells.length === externalColumnDates.length) {
        return { columns: externalColumnDates, dataStartRowIdx: i + 1 };
      }
    }
  }
  return null;
}

// Scans arbitrary text for every "<Month> <Day>, <Year>" (or "<Month>
// <Day> <Year>") occurrence, in order -- the unanchored sibling of
// parseDateHeaderCell's own compound-date branch, for pulling MULTIPLE
// real dates out of a whole caption/sentence rather than matching one
// whole cell exactly. Deliberately does not strip an "as of/as at" prefix
// here (unlike parseDateHeaderCell) -- callers scan a whole caption that
// may embed that phrase anywhere, not just at the very start of the text
// being tested.
function findDatesInText(text) {
  const matches = [...text.matchAll(/([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s*((?:19|20)\d{2})/g)];
  return matches.map((m) => ({ endMonthDay: `${m[1]} ${m[2]}`, year: m[3] }));
}

// Sibling of findExternalPeriodPhrase (see its own comment) for the
// instant/balance-sheet case -- scans the elements between a heading and
// its matched table for real dates stated in prose, accumulating matches
// across every leaf in range (a caption is often split across several
// sibling <font> elements, e.g. SGHC's "as at June 30, 2026" / "and
// December 31, 2025 in $ millions" as two separate leaves under one
// wrapping, non-leaf <div>).
function findExternalInstantColumnDates($, allEls, startIdx, endIdx) {
  const dates = [];
  for (let i = startIdx; i < endIdx; i++) {
    const $el = $(allEls[i]);
    const text = $el.text();
    if (!isHeadingLeaf($, $el) || text.length > MAX_HEADING_TEXT_LENGTH) continue;
    dates.push(...findDatesInText(text));
  }
  return dates;
}

// A bare "<Month> <Day>" with NO year -- unlike findDatesInText above
// (which requires one). Verified live: PAC's real balance-sheet caption
// reads "Consolidated statement of financial position as of March 31 (in
// thousands of pesos)" -- no year anywhere in the caption at all, since
// both comparison years (2025/2026) share the same fiscal quarter-end
// month/day and the filer only states it once. Tried only as a last
// resort (see parseInstantTableColumns' own comment) -- a caption that
// DOES carry a real year is already handled by findExternalInstantColumnDates
// above, called first by this function's caller.
function findExternalBareMonthDay($, allEls, startIdx, endIdx) {
  for (let i = startIdx; i < endIdx; i++) {
    const $el = $(allEls[i]);
    const text = $el.text();
    if (!isHeadingLeaf($, $el) || text.length > MAX_HEADING_TEXT_LENGTH) continue;
    const m = text.match(/as\s+(?:of|at)\s+([A-Za-z]+\.?\s+\d{1,2})/i);
    if (m) return m[1].replace(/\.$/, '');
  }
  return null;
}

// Parses every date column in an already-located balance-sheet <table> —
// unlike extractFromTable (which targets ONE specific quarter), every
// column here is independently useful (a filing's own current-period AND
// prior-year-comparative snapshots are both real, previously-undisclosed-
// elsewhere data points), so this returns one result per column rather than
// a single target period.
function extractFromInstantTable($, table, aliasMap, externalColumnDates = null, externalBareMonthDay = null) {
  const parsed = parseInstantTableColumns($, table, externalColumnDates, externalBareMonthDay);
  if (!parsed) return [];
  const { columns, dataStartRowIdx, rawColumnCount, valueIndices } = parsed;
  // See extractFromTable's identical rawColumnCount/valueIndices handling
  // -- only ever set by parseInstantTableColumns' own trailing-Change/%
  // detection (see detectTrailingChangeColumns), absent for every other
  // header shape, where this is exactly the pre-existing behavior.
  const parsedRowColumnCount = rawColumnCount ?? columns.length;
  // See extractAllAnnualColumnsFromTable's identical call -- this table's
  // own header ("$ in Thousands"/"in Millions") applies here too, and
  // without it a balance-sheet concept comes out 1000x too SMALL relative
  // to an income-statement concept from the SAME filing's duration tables
  // (which already gets this correction), silently inflating any ratio
  // that divides one by the other. Verified live: ASR's real "Total
  // stockholders' equity" row literally reads "46,406,366" under a "$ in
  // Thousands" header (so its real value is ~46.4 BILLION pesos, not 46.4
  // million) while its EBIT for the same year had already been correctly
  // scaled to ~17 billion -- without this fix, roic (NOPAT ÷ invested
  // capital, which uses this unscaled equity) computed to 306.83 (a
  // nonsensical 30,683%) instead of a real, plausible figure.
  const scale = detectTableScale($, table);

  const rows = $(table).find('tr').toArray();
  const candidatesByColumn = columns.map(() => ({})); // concept -> [{label, value}]
  for (let i = dataStartRowIdx; i < rows.length; i++) {
    const cells = nonEmptyCells($, rows[i]);
    if (!cells.length) continue;
    const row = parseDataRow(cells, parsedRowColumnCount);
    if (!row) continue;
    if (valueIndices) row.values = valueIndices.map((idx) => row.values[idx]);
    if (scale !== 1) row.values = row.values.map((v) => v * scale);
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
      const resolved = resolveConceptCandidates(list, concept, 'value');
      if (!resolved) continue;
      if (resolved.winner) { results[concept] = resolved.winner; continue; }
      // debt-only sum here (capex is extractFromTable's duration-side
      // concept) -- current + non-current portions are two real, genuinely
      // separate lines with no single "Total debt" row — see
      // LABEL_ALIASES.debt's own comment. Safe because the sum still has to
      // pass reconcileInstantPoints before it's ever trusted.
      if (resolved.sum && concept === 'debt') {
        results[concept] = { label: resolved.sum.map((d) => d.label).join(' + '), value: resolved.sum.reduce((sum, d) => sum + d.value, 0) };
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

// Scans the elements strictly between a statement's heading and its data
// table for standalone period-phrase leaves (e.g. CPA's own separate "For
// the six months ended" <div>, sitting between the "Consolidated statement
// of cash flows" heading and the table itself) -- see parseTableColumns'
// own comment on why a phrase living outside the table can never be found
// by that function's row-by-row search alone. Same leaf-ness/length rule
// as the heading search above, so an unrelated container that merely
// CONTAINS this wording somewhere deep inside doesn't false-match.
//
// Returns EVERY matching phrase found, not just the first -- verified
// live: SGHC's real mid-year cash-flow caption states TWO distinct
// phrases, each already carrying its own embedded date -- "for the six
// months ended June 30, 2026" and "and twelve months ended December 31,
// 2025" (a mid-year release comparing H1 2026 against the PRIOR FULL
// YEAR's cash flow, not just prior H1). A single-phrase hint applied
// uniformly across both table columns (CPA's own shape, where one bare
// phrase with no date of its own covers both years identically) would be
// WRONG here -- the two years need two different (months, endMonthDay)
// pairs. Returning both in document order lets the caller's existing
// positional periodPhrases[Math.floor(idx/yearsPerPeriod)] pairing (see
// parseTableColumns) resolve this exactly like any other same-row
// multi-phrase header, with yearsPerPeriod naturally settling to 1 when
// the phrase count already matches the date-cell count 1:1.
// A compound caption naming TWO different durations before a single
// "month(s) ended" suffix -- verified live: ASR's real caption reads "For
// the six and three-month periods ended June 30, 2026 and 2025" (one
// sentence covering BOTH its six-month and three-month columns, unlike
// SGHC's two fully separate phrases above, each with its own "months
// ended"). parsePeriodPhrase has no way to represent two durations in one
// {months, endMonthDay} result -- it matched only "three-month" (the
// first OR-branch "six[\s-]months?" requires "six" immediately followed by
// "month", not "six and three-month"), silently discarding the six-month
// half entirely. Treating this single, WRONG-duration phrase as
// authoritative then preempted the table's own correct in-row "Six months
// period ended"/"Three months period ended" header (parseTableColumns
// never reaches its own row-scanning once externalPeriodPhrases is
// non-empty) -- collapsing 4 real columns (6mo-2026, 6mo-2025, 3mo-2026,
// 3mo-2025) down to 4 WRONGLY-labeled 3-month columns with duplicate
// years, silently swapping the real standalone quarter for the six-month
// cumulative total under its label. Safer to recognize this shape and
// skip it entirely than to guess which duration is "primary" -- the table
// almost always spells out each duration separately in its own header
// when a caption like this combines them, so deferring to that is
// strictly more informative than a wrong single-duration hint.
const COMPOUND_DURATION_CAPTION = /(three|six|nine|twelve|3|6|9|12)[\s-]and[\s-](three|six|nine|twelve|3|6|9|12)[\s-]month/i;

function findExternalPeriodPhrases($, allEls, startIdx, endIdx) {
  const phrases = [];
  for (let i = startIdx; i < endIdx; i++) {
    const $el = $(allEls[i]);
    const text = $el.text();
    if (!isHeadingLeaf($, $el) || text.length > MAX_HEADING_TEXT_LENGTH || !PERIOD_PHRASE_INDICATOR.test(text)) continue;
    if (COMPOUND_DURATION_CAPTION.test(text)) continue;
    const parsed = parsePeriodPhrase(text);
    if (parsed) phrases.push(parsed);
  }
  return phrases;
}

// Locates a statement's heading + immediately-following <table> in a big
// combined document (press release or formal financial-statements exhibit
// — STNG/IAG/CNQ/AEM style), then delegates to extractFromTable.
function extractStatement($, headingRegex, targetEndYear, aliasMap, cumulativeFallbackConcepts) {
  const allEls = $('body *').toArray();
  const headingIdxs = [];
  for (let i = 0; i < allEls.length; i++) {
    const $el = $(allEls[i]);
    const text = $el.text();
    if (isHeadingLeaf($, $el) && text.length <= MAX_HEADING_TEXT_LENGTH && headingRegex.test(text)) headingIdxs.push(i);
  }
  if (process.env.DEBUG_EXTRACT_STATEMENT) {
    console.error(
      'DEBUG extractStatement headingIdxs',
      headingIdxs.length,
      headingIdxs.map((i) => JSON.stringify($(allEls[i]).text().trim().slice(0, 80)))
    );
    for (const headingIdx of headingIdxs) {
      const tables = findStatementTables($, allEls, headingIdx);
      console.error('DEBUG extractStatement headingIdx', headingIdx, 'tables found:', tables.length);
    }
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
      const tableIdx = allEls.indexOf(table);
      const externalPeriodPhrases = tableIdx > headingIdx ? findExternalPeriodPhrases($, allEls, headingIdx + 1, tableIdx) : [];
      const result = extractFromTable($, table, targetEndYear, aliasMap, cumulativeFallbackConcepts, externalPeriodPhrases);
      if (!result) continue;
      if (!merged) merged = result;
      else merged = { period: merged.period, facts: { ...result.facts, ...merged.facts } };
    }
  }
  return merged;
}

// A TENTH shape, verified live: NBIS (Nebius Group N.V., formerly Yandex
// N.V.) discloses its real standalone-quarter cash-flow figures ONLY
// inside an MD&A-style "Cash Flows" summary subsection -- its real 6-K
// exhibits never carry a formal "Consolidated Statement of Cash Flows"
// heading anywhere at all (confirmed live: extractStatement above finds
// nothing for STATEMENT_HEADINGS.cashflow in the whole document). The
// real summary reads: a short, standalone "Cash Flows" heading (bold+
// italic <font>, not a formal statement title) immediately followed by a
// sentence "Set out below is a summary of cash flows from continuing
// operations for the three months ended March 31, 2025 and 2026.", then
// an ordinarily-shaped table (period-phrase + bare-year-row header,
// already handled by the existing parseTableColumns machinery -- no new
// date parsing needed here, just a new way to LOCATE the table).
//
// Deliberately gated behind BOTH the exact, whole-string "Cash Flows"
// heading text AND the specific "summary of cash flows" confirmatory
// sentence immediately after it -- a bare "Cash Flows" heading alone is
// far too generic a phrase to trust on its own, given how widely this
// function's caller applies (every foreign filer's every exhibit, not
// just NBIS's). Tried unconditionally alongside the formal heading
// search, not instead of it -- harmless for a filer that already has a
// real formal statement, since any resulting duplicate candidate for the
// same period still has to independently pass reconcilePoints below like
// any other candidate; this only ever ADDS a real, verifiable candidate
// where none existed before.
function extractMdaCashFlowSummary($, targetEndYear, aliasMap, cumulativeFallbackConcepts) {
  const allEls = $('body *').toArray();
  let merged = null;
  for (let i = 0; i < allEls.length; i++) {
    const $el = $(allEls[i]);
    const text = $el.text().trim();
    if (!isHeadingLeaf($, $el) || text.length > 40 || !/^cash\s+flows?$/i.test(text)) continue;
    let confirmed = false;
    for (let j = i + 1; j < Math.min(i + 6, allEls.length); j++) {
      if (/summary of (the )?cash\s*flows?/i.test($(allEls[j]).text())) { confirmed = true; break; }
    }
    if (!confirmed) continue;
    for (const table of findStatementTables($, allEls, i)) {
      const result = extractFromTable($, table, targetEndYear, aliasMap, cumulativeFallbackConcepts);
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
      const tableIdx = allEls.indexOf(table);
      const externalColumnDates = tableIdx > headingIdx ? findExternalInstantColumnDates($, allEls, headingIdx + 1, tableIdx) : [];
      // Scanned from headingIdx itself (inclusive), not headingIdx + 1 --
      // verified live: PAC's real caption ("...as of March 31 (in
      // thousands of pesos):") sits in the SAME leaf as the heading text
      // itself ("Exhibit B: Consolidated statement of financial position
      // as of March 31..."), not a separate sibling after it. Only tried
      // when the stronger, full-date source above found nothing, so this
      // can't override a real multi-year caption elsewhere.
      const externalBareMonthDay = externalColumnDates.length < 2 && tableIdx >= headingIdx ? findExternalBareMonthDay($, allEls, headingIdx, tableIdx) : null;
      const result = extractFromInstantTable($, table, aliasMap, externalColumnDates, externalBareMonthDay);
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
function extractFromRFile($, targetEndYear, aliasMap, cumulativeFallbackConcepts) {
  const tables = $('table').toArray();
  for (const table of tables) {
    if ($(table).find('tr').length < 5) continue;
    const result = extractFromTable($, table, targetEndYear, aliasMap, cumulativeFallbackConcepts);
    if (result) return result;
  }
  return null;
}

// Instant-fact (balance-sheet) counterpart to extractFromRFile above — same
// per-page table search, calling extractFromInstantTable instead. Closes a
// real pre-existing gap: the R-file loop in extractQuarterlyFactsFromFilings
// previously only ever tried income/cashflow aliases against R-files, never
// balance-sheet ones — only the slower exhibit-scan fallback path attempted
// equity/debt/cash extraction at all, even for Inline XBRL filings whose
// FilingSummary.xml already points straight at the exact balance-sheet
// R-file (verified live: DHT's own manifest lists "Consolidated Statement
// of Financial Position" as its own R-file, same as its cash-flow one).
function extractFromInstantRFile($, aliasMap) {
  const tables = $('table').toArray();
  for (const table of tables) {
    if ($(table).find('tr').length < 5) continue;
    const result = extractFromInstantTable($, table, aliasMap);
    if (result.length) return result;
  }
  return [];
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
async function extractQuarterlyFactsFromFilings(cik, neededConcepts, annualByEnd, userAgent, cumulativeFallbackConcepts, symbol) {
  const submissions = await fetchJsonSec(`${SEC_SUBMISSIONS_BASE}/CIK${cik}.json`, userAgent);
  if (!submissions?.filings?.recent) return {};

  const minSubstantiveBytes = MIN_SUBSTANTIVE_FILING_BYTES_OVERRIDES[symbol] ?? MIN_SUBSTANTIVE_FILING_BYTES;
  const nativeCurrency = NATIVE_CURRENCY_OVERRIDES[symbol] || null;
  const r = submissions.filings.recent;
  const filings = [];
  for (let i = 0; i < r.form.length && i < FILING_LOOKBACK_ENTRIES && filings.length < MAX_FILINGS_TO_SCAN; i++) {
    const size = r.size?.[i];
    if (r.form[i] === '6-K' && (size == null || size >= minSubstantiveBytes)) {
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
  const collected = { revenue: new Map(), netIncome: new Map(), ebit: new Map(), pretaxIncome: new Map(), totalExpenses: new Map(), ocf: new Map(), capex: new Map(), shares: new Map(), equity: new Map(), debt: new Map(), cash: new Map() };
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
  // nativeCurrency is set once per call to extractQuarterlyFactsFromFilings
  // (null for the ~1000+ filers this file already handles without it) --
  // see NATIVE_CURRENCY_OVERRIDES' own comment. Every value this function
  // records has already been through convertNativeCurrencyToUsd by the
  // time it reaches `collected`, so nothing downstream of this function
  // (reconciliation, decumulation, dedupeAndClassify) needs to know or
  // care that a conversion ever happened.
  async function recordExtracted(extracted, filing) {
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
      let val = fact.value3mo;
      let valueCumulative = fact.valueCumulative;
      if (nativeCurrency) {
        val = val != null ? await convertNativeCurrencyToUsd(val, nativeCurrency, { start: startIso, end: endIso }) : null;
        valueCumulative = valueCumulative != null ? await convertNativeCurrencyToUsd(valueCumulative, nativeCurrency, { start: startIso, end: endIso }) : null;
        if (val == null) continue; // FX fetch/lookup failed -- never record a half-converted or fabricated figure
      }
      const list = collected[concept].get(endIso) || [];
      if (!list.some((l) => l.accessionNumber === filing.accessionNumber)) {
        list.push({ start: startIso, end: endIso, val, valueCumulative, filed: filing.filingDate, accessionNumber: filing.accessionNumber });
      }
      collected[concept].set(endIso, list);
    }
  }

  // Instant-fact counterpart to recordExtracted above — no start date (a
  // balance-sheet snapshot has no duration), and extractFromInstantTable
  // already returns one entry PER DATE COLUMN, so this is called once per
  // column rather than once per statement.
  async function recordExtractedInstant(extractedList, filing) {
    for (const extracted of extractedList) {
      const endIso = monthDayYearToIso(extracted.period.endMonthDay, extracted.period.year);
      if (!endIso) continue;
      for (const [concept, fact] of Object.entries(extracted.facts)) {
        let val = fact.value;
        if (nativeCurrency) {
          val = val != null ? await convertNativeCurrencyToUsd(val, nativeCurrency, { end: endIso }) : null;
          if (val == null) continue;
        }
        const list = collected[concept].get(endIso) || [];
        if (!list.some((l) => l.accessionNumber === filing.accessionNumber)) {
          list.push({ end: endIso, val, filed: filing.filingDate, accessionNumber: filing.accessionNumber });
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
        // shares included here too, not just in its own dedicated pass below
        // -- verified live: CNI (Canadian National Railway) discloses its
        // "Weighted-average number of shares" row INSIDE the income
        // statement's own table (right after "Earnings per share"), not in
        // a genuinely separate note the way TNK does. Purely additive: a
        // filer whose shares row really is separate (TNK) still finds
        // nothing extra here and is unaffected.
        const incomeAliases = Object.fromEntries(Object.entries({ revenue: aliasMap.revenue, netIncome: aliasMap.netIncome, ebit: aliasMap.ebit, pretaxIncome: aliasMap.pretaxIncome, totalExpenses: aliasMap.totalExpenses, shares: aliasMap.shares }).filter(([, v]) => v));
        const cashflowAliases = Object.fromEntries(Object.entries({ ocf: aliasMap.ocf, capex: aliasMap.capex }).filter(([, v]) => v));
        // Balance-sheet (equity/debt/cash) R-files -- previously only ever
        // attempted via the slower exhibit-scan fallback below, even when
        // FilingSummary.xml already pointed straight at the right R-file
        // (verified live: DHT's manifest lists "Consolidated Statement of
        // Financial Position" as its own R-file, same shape as its
        // cash-flow one). See extractFromInstantRFile's own comment.
        const balanceSheetAliases = Object.fromEntries(Object.entries({ equity: aliasMap.equity, debt: aliasMap.debt, cash: aliasMap.cash }).filter(([, v]) => v));
        // Shares R-file -- its own note/heading, NOT the main income
        // statement -- see STATEMENT_HEADINGS.earningsPerShare's own comment.
        const sharesAliases = Object.fromEntries(Object.entries({ shares: aliasMap.shares }).filter(([, v]) => v));
        const matches = [
          ...(Object.keys(incomeAliases).length ? reports.filter((rep) => STATEMENT_HEADINGS.income.test(rep.shortName) || STATEMENT_HEADINGS.income.test(rep.longName)).map((rep) => ({ rep, aliases: incomeAliases, instant: false })) : []),
          ...(Object.keys(cashflowAliases).length ? reports.filter((rep) => STATEMENT_HEADINGS.cashflow.test(rep.shortName) || STATEMENT_HEADINGS.cashflow.test(rep.longName)).map((rep) => ({ rep, aliases: cashflowAliases, instant: false })) : []),
          ...(Object.keys(balanceSheetAliases).length ? reports.filter((rep) => STATEMENT_HEADINGS.balanceSheet.test(rep.shortName) || STATEMENT_HEADINGS.balanceSheet.test(rep.longName)).map((rep) => ({ rep, aliases: balanceSheetAliases, instant: true })) : []),
          ...(Object.keys(sharesAliases).length ? reports.filter((rep) => STATEMENT_HEADINGS.earningsPerShare.test(rep.shortName) || STATEMENT_HEADINGS.earningsPerShare.test(rep.longName)).map((rep) => ({ rep, aliases: sharesAliases, instant: false })) : []),
        ];
        if (matches.length) usedFilingSummary = true;
        for (const { rep, aliases, instant } of matches) {
          const accessionNoDashes = filing.accessionNumber.replace(/-/g, '');
          const rUrl = `${SEC_ARCHIVES_BASE}/${Number(cik)}/${accessionNoDashes}/${rep.htmlFileName}`;
          const html = await fetchText(rUrl, userAgent);
          if (debug) console.error('DEBUG R-file', rUrl, rep.shortName || rep.longName);
          if (!html) continue;
          const $ = cheerio.load(html);
          if (instant) {
            let extractedList;
            try {
              extractedList = extractFromInstantRFile($, aliases);
            } catch (e) {
              if (debug) console.error('DEBUG extractFromInstantRFile threw', rUrl, e.message);
              continue;
            }
            if (debug) console.error('DEBUG extractFromInstantRFile result', rUrl, JSON.stringify(extractedList));
            await recordExtractedInstant(extractedList, filing);
            continue;
          }
          for (const year of candidateYears) {
            let extracted;
            try {
              extracted = extractFromRFile($, year, aliases, cumulativeFallbackConcepts);
            } catch (e) {
              if (debug) console.error('DEBUG extractFromRFile threw', rUrl, year, e.message);
              continue;
            }
            if (debug) console.error('DEBUG extractFromRFile result', rUrl, year, JSON.stringify(extracted));
            await recordExtracted(extracted, filing);
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
      const hasEarningsPerShare = STATEMENT_HEADINGS.earningsPerShare.test(fullText);
      if (debug) console.error('DEBUG', url, 'hasIncome', hasIncome, 'hasCashflow', hasCashflow, 'hasBalanceSheet', hasBalanceSheet, 'hasEarningsPerShare', hasEarningsPerShare);
      if (!hasIncome && !hasCashflow && !hasBalanceSheet && !hasEarningsPerShare) continue;

      // Try every year we might plausibly need (this filing's own filing
      // year and the one prior) rather than assuming which quarter it covers.
      const candidateYears = [String(new Date(filing.filingDate).getUTCFullYear()), String(new Date(filing.filingDate).getUTCFullYear() - 1)];

      for (const heading of [STATEMENT_HEADINGS.income, STATEMENT_HEADINGS.cashflow, STATEMENT_HEADINGS.earningsPerShare]) {
        // shares included in incomeAliases too -- see the identical addition
        // (and its own comment) in the FilingSummary/R-file branch above.
        const incomeAliases = { revenue: aliasMap.revenue, netIncome: aliasMap.netIncome, ebit: aliasMap.ebit, pretaxIncome: aliasMap.pretaxIncome, totalExpenses: aliasMap.totalExpenses, shares: aliasMap.shares };
        const cashflowAliases = { ocf: aliasMap.ocf, capex: aliasMap.capex };
        const sharesAliases = { shares: aliasMap.shares };
        const relevantAliases =
          heading === STATEMENT_HEADINGS.income ? incomeAliases : heading === STATEMENT_HEADINGS.cashflow ? cashflowAliases : sharesAliases;
        const filtered = Object.fromEntries(Object.entries(relevantAliases).filter(([, v]) => v));
        // Which concepts actually got REQUESTED for this heading -- useful
        // when a concept was confirmed needed (see the caller's own
        // 'needed-check' trace) but never shows up in this loop's
        // extractStatement results below, narrowing whether the gap is in
        // the request itself or in extractStatement's own label matching.
        if (debug) console.error('DEBUG filtered-aliases', url, 'heading', heading === STATEMENT_HEADINGS.income ? 'income' : heading === STATEMENT_HEADINGS.cashflow ? 'cashflow' : 'shares', 'requested', Object.keys(filtered));
        if (!Object.keys(filtered).length) continue;

        for (const year of candidateYears) {
          let extracted;
          try {
            extracted = extractStatement($, heading, year, filtered, cumulativeFallbackConcepts);
          } catch (e) {
            if (debug) console.error('DEBUG extractStatement threw', url, year, e.message);
            continue;
          }
          if (debug) console.error('DEBUG extractStatement result', url, year, JSON.stringify(extracted));
          await recordExtracted(extracted, filing);
        }
      }

      // MD&A "Cash Flows" summary fallback -- see extractMdaCashFlowSummary's
      // own comment (built for NBIS). Tried unconditionally alongside the
      // formal heading search above, not gated on hasCashflow having come
      // back false -- cheap, and harmless for a filer whose formal
      // statement already worked (any resulting duplicate still has to
      // independently pass reconcilePoints below).
      const mdaCashflowAliases = Object.fromEntries(Object.entries({ ocf: aliasMap.ocf, capex: aliasMap.capex }).filter(([, v]) => v));
      if (Object.keys(mdaCashflowAliases).length) {
        for (const year of candidateYears) {
          let extracted;
          try {
            extracted = extractMdaCashFlowSummary($, year, mdaCashflowAliases, cumulativeFallbackConcepts);
          } catch (e) {
            if (debug) console.error('DEBUG extractMdaCashFlowSummary threw', url, year, e.message);
            continue;
          }
          if (debug) console.error('DEBUG extractMdaCashFlowSummary result', url, year, JSON.stringify(extracted));
          await recordExtracted(extracted, filing);
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
        await recordExtractedInstant(extractedList, filing);
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
      if (process.env.DEBUG_CUMULATIVE_IDX && concept === 'revenue' && end.startsWith('2025-03')) console.error('DEBUG revenue-list-2025Q1', JSON.stringify(list));
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
      // hasConflict -- true when independent filings disagree on this
      // period's value (byValue has more than one distinct value, not just
      // one value with multiple corroborating copies). Verified live: DEFi
      // Technologies/DEFT's own Q1'25 "Total revenues" reads $62.66M in its
      // own Q1'25 earnings release but $43.79M in a LATER release's
      // comparative column -- a real disagreement between two independent
      // filings, not a parsing bug. Under the old >= 2 bar this correctly
      // never published (neither number repeats, so neither gets 2
      // corroborations) -- but trustSingleSource's corroborations >= 1
      // check would otherwise verify WHICHEVER of the two disagreeing
      // values happened to win the tiebreak above, silently presenting one
      // arbitrary pick as fact. Gating trustSingleSource on `!hasConflict`
      // keeps it applying only when a period has exactly one candidate
      // value with nothing to disagree with (ASR's Q2'26 case -- only ever
      // reported once, period) while still requiring real 2-source
      // agreement whenever multiple filings actively disagree.
      points.push({
        ...rep,
        corroborations: new Set(best.map((o) => o.accessionNumber)).size,
        accessionNumbers: new Set(best.map((o) => o.accessionNumber)),
        hasConflict: byValue.size > 1,
      });
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
  //
  // That assumption doesn't always hold, though -- see detectScaleMultiplier's
  // own comment for the real ASR counter-example (income statement in raw
  // pesos, cash-flow statement "$ in Thousands", same filing). `global` is
  // this function's ORIGINAL single shared scale, still applied to any
  // concept with no strong disagreeing evidence of its own; `perConcept`
  // (from a concept whose OWN evidence actually disagrees) overrides it
  // for just that concept, resolved per concept below via `scaleFor`.
  const { global: globalScale, perConcept: conceptScaleOverrides } = detectScaleMultiplier(pointsByConcept, annualByEnd);
  if (process.env.DEBUG_CUMULATIVE_IDX) console.error('DEBUG scale-resolution', 'global', globalScale, 'perConcept', JSON.stringify([...conceptScaleOverrides]));
  const scaleFor = (concept) => conceptScaleOverrides.get(concept) ?? globalScale;
  if (globalScale !== 1 || conceptScaleOverrides.size) {
    for (const [concept, points] of pointsByConcept) {
      const scale = scaleFor(concept);
      if (scale === 1) continue;
      // A share COUNT is USUALLY never abbreviated the way a dollar figure
      // is -- verified live: STNG's earnings-release table states OCF/
      // capex/net income "in thousands" but its weighted-average-share-
      // count row in the SAME table is a plain, full number (e.g.
      // "46,284,629", not "46,285"). Applying a detected dollar-scale
      // correction to shares too silently inflated a real ~53M share count
      // to ~53 BILLION the first time this function was ever asked to
      // score a concept (net income) with a strong enough annual anchor to
      // actually trigger a correction alongside shares in the same batch.
      //
      // USUALLY, though, not always -- verified live: CNI (Canadian
      // National Railway) states its real "Weighted-average basic shares
      // outstanding" as "606.5" (606.5 MILLION, matching the SAME
      // in-millions convention as the rest of that table), directly
      // contradicting the STNG-derived assumption above for this filer.
      // A blanket exemption left CNI's shares 1,000,000x too small,
      // corrupting every P/FCF-per-share and EPS figure built from it
      // (both divide by shares) into a near-zero garbage ratio even after
      // the reconciled OCF/capex/netIncome feeding the same calculation
      // were correctly scaled. Detected here per-filer instead of assumed
      // either way: no real public company has a weighted-average share
      // count under MIN_PLAUSIBLE_RAW_SHARES -- if the RAW extracted value
      // already clears that bar (STNG's case), leave it alone; only apply
      // the same correction when the raw value is implausibly tiny AND
      // scaling it lands in a plausible range (CNI's case). Falls through
      // to the ordinary scale-everything path below when true; NON_ADDITIVE_
      // CONCEPTS' OTHER meaning (not summable across quarters, Check B's
      // guard just below) is untouched by this.
      if (NON_ADDITIVE_CONCEPTS.has(concept)) {
        const maxRaw = Math.max(0, ...points.map((p) => Math.abs(p.val)));
        const impliesScalingNeeded = maxRaw > 0 && maxRaw < MIN_PLAUSIBLE_RAW_SHARES && maxRaw * scale >= MIN_PLAUSIBLE_RAW_SHARES;
        if (!impliesScalingNeeded) continue;
      }
      // INSTANT_CONCEPTS (equity/debt/cash) excluded here too -- excluding
      // them from detectScaleMultiplier's own scoring (see that function's
      // comment) only stops their messy same-year-snapshot data from
      // influencing WHICH scale gets picked; it doesn't stop a scale this
      // step picked for OTHER (legitimate flow-concept) reasons from then
      // being applied to them anyway. Their own scale is already resolved
      // independently and correctly upstream, per-table, by
      // extractFromInstantTable's own detectTableScale (see that
      // function's own comment, written for the original ASR equity-scale
      // bug) -- applying a SECOND, unrelated scale on top of an already-
      // correct value is never right, no matter what bestScale resolves to
      // for this filing's flow concepts. Verified live: ITRN's real
      // extractFromInstantRFile output ($224,486,000 equity) was already
      // correct, but this step's own blanket scale application (triggered
      // by some unrelated flow-concept candidate elsewhere in the same
      // batch) multiplied it by another 1000x anyway, corrupting ROIC's
      // invested-capital denominator into producing ~0.03% instead of the
      // real ~28%.
      if (INSTANT_CONCEPTS.has(concept)) continue;
      for (const p of points) {
        p.val *= scale;
        if (p.valueCumulative != null) p.valueCumulative *= scale;
      }
    }
  }

  // trustSingleSource now also passed here (previously 20-F-annual-path
  // only -- see reconcilePoints' own comment). Per explicit product
  // decision: Check A (same-document cumulative self-check) was the
  // preferred safer alternative, but verified live it structurally cannot
  // help a filer like ASR, which only ever discloses ONE standalone
  // quarter per year (its H1 release breaks out Q2 alone, with no Q1/Q3/Q4
  // counterpart ever disclosed) -- Check A's own sum-of-consecutive-
  // quarters logic requires at least 2 real quarters to chain, so a
  // single quarter can never self-verify no matter how correctly it's
  // extracted. Rather than leave these filers waiting up to a year for a
  // second filing to happen to repeat the same figure, trust a single 6-K
  // extraction the same way a single 20-F extraction already is. This is
  // a real step down in safety vs. the 20-F case (free-text/HTML table
  // parsing, not structured XBRL -- this file's own history this session
  // includes several real extraction bugs: ASR's own external-caption
  // duration-collapsing bug just above, BTI's array-position bug, NBIS's
  // zero-width-space bug, OMAB's dual-currency columns), accepted
  // knowingly rather than overlooked.
  const result = {};
  for (const [concept, points] of pointsByConcept) {
    if (process.env.DEBUG_CUMULATIVE_IDX && concept === 'revenue') console.error('DEBUG points-before-reconcile revenue', JSON.stringify(points.map((p) => ({ end: p.end, val: p.val, corroborations: p.corroborations, hasConflict: p.hasConflict }))));
    const verified = INSTANT_CONCEPTS.has(concept)
      ? reconcileInstantPoints(points, annualByEnd?.[concept] || new Map(), accessionToDatesByConcept.get(concept), true)
      : reconcilePoints(points, annualByEnd?.[concept] || new Map(), concept, true);
    if (process.env.DEBUG_CUMULATIVE_IDX && concept === 'revenue') console.error('DEBUG verified-after-reconcile revenue', JSON.stringify(verified.map((p) => ({ end: p.end, val: p.val }))));
    if (verified.length) {
      result[concept] = verified.map((p) => ({ start: p.start, end: p.end, val: p.val, filed: p.filed }));
    }
  }
  return result;
}

/**
 * Annual counterpart to extractQuarterlyFactsFromFilings above -- extracts
 * real annual facts for `neededConcepts` from a ticker's 3 most recent
 * 20-F filings (see MAX_20F_FILINGS_TO_SCAN's own comment for why 3, and
 * why no exhibit-scan fallback is needed here the way the 6-K path has one:
 * 20-Fs are Inline XBRL, and FilingSummary.xml already pointed straight at
 * the right R-file for both real filers checked live (DHT, IMPP) -- add a
 * heading-search fallback (reusing extractStatement/extractInstantStatement
 * against the raw 20-F document, same shape as the 6-K exhibit-scan path)
 * only if a real 20-F filer without one ever turns up.
 *
 * Fills a genuinely different gap than the 6-K path: a foreign filer whose
 * 20-F switched a concept to a company-specific custom XBRL extension tag
 * (verified live: DHT's `dht:InvestmentsInVessels`), which SEC's structured
 * companyfacts API never exposes at all under any standard taxonomy name,
 * no matter how many concept-list alternatives are added -- only parsing
 * the document itself recovers it. `annualByEnd` is the same real-annual-
 * XBRL reconciliation anchor the 6-K path already threads through (Check
 * B); for a concept whose real XBRL genuinely stopped (like DHT's capex),
 * Check C (cross-filing corroboration, built into how MAX_20F_FILINGS_TO_SCAN
 * is chosen) and Check D (same-document section-subtotal self-check, see
 * reconcilePoints' own comment) do the real verification work instead.
 *
 * Returns { [concept]: Array<{start, end, val, filed}> } -- identical shape
 * to extractQuarterlyFactsFromFilings/extractFactSeries, so callers merge
 * it into their raw fact arrays via the exact same
 * dedupeAndClassify([...raw, ...new20FFacts]) idiom used everywhere else.
 */
async function extractAnnualFactsFrom20F(cik, neededConcepts, annualByEnd, userAgent) {
  const submissions = await fetchJsonSec(`${SEC_SUBMISSIONS_BASE}/CIK${cik}.json`, userAgent);
  if (!submissions?.filings?.recent) return {};

  const r = submissions.filings.recent;
  const filings = [];
  // Exact form-type match ('20-F'/'40-F', not their '/A' amendments) --
  // same reasoning as the 6-K path excluding '6-K/A': two entries must be
  // genuinely independent filings for cross-filing corroboration (Check C)
  // to mean anything. '40-F' added alongside '20-F' -- verified live for
  // OGI (a Canadian MJDS filer, 40-F not 20-F): its 40-F filings carry the
  // exact same FilingSummary.xml/R-file structure this function already
  // parses, just under a different form-type label -- this function was
  // ONLY ever gated on '20-F' though, so every 40-F filer (all Canadian
  // MJDS foreign filers -- CN railways, cannabis, mining, etc. -- a real,
  // sizeable chunk of foreignFilerList.json) was silently excluded from a
  // mechanism that works identically for them.
  const ANNUAL_RECOVERY_FORM_TYPES = new Set(['20-F', '40-F']);
  for (let i = 0; i < r.form.length && filings.length < MAX_20F_FILINGS_TO_SCAN; i++) {
    if (ANNUAL_RECOVERY_FORM_TYPES.has(r.form[i])) filings.push({ accessionNumber: r.accessionNumber[i], filingDate: r.filingDate[i] });
  }
  if (!filings.length) return {};

  const collected = { revenue: new Map(), netIncome: new Map(), ebit: new Map(), pretaxIncome: new Map(), totalExpenses: new Map(), ocf: new Map(), capex: new Map(), shares: new Map(), equity: new Map(), debt: new Map(), cash: new Map() };
  const aliasMap = {};
  for (const c of neededConcepts) if (LABEL_ALIASES[c]) aliasMap[c] = LABEL_ALIASES[c];

  const debug = !!process.env.DEBUG_FILING_EXTRACT;

  // Duration-concept counterpart to recordExtractedInstant above --
  // computes each fact's own real start date from its real 12-month
  // duration (subtractMonths(endIso, 12), same helper the 6-K path already
  // uses for its own 3/6/9-month periods), and carries sectionVerified
  // through from extractAllAnnualColumnsFromTable's own per-concept flag
  // (feeds Check D below).
  function recordExtractedAnnual(extractedList, filing) {
    for (const extracted of extractedList) {
      const endIso = monthDayYearToIso(extracted.period.endMonthDay, extracted.period.year);
      if (!endIso) continue;
      const startIso = subtractMonths(endIso, extracted.period.months);
      for (const [concept, fact] of Object.entries(extracted.facts)) {
        const list = collected[concept].get(endIso) || [];
        if (!list.some((l) => l.accessionNumber === filing.accessionNumber)) {
          list.push({
            start: startIso,
            end: endIso,
            val: fact.value,
            filed: filing.filingDate,
            accessionNumber: filing.accessionNumber,
            sectionVerified: extracted.sectionVerifiedConcepts?.has(concept) || false,
          });
        }
        collected[concept].set(endIso, list);
      }
    }
  }

  function recordExtractedInstantAnnual(extractedList, filing) {
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

  // shares included in incomeAliases too -- see the identical addition (and
  // its own comment) in extractQuarterlyFactsFromFilings' R-file branch.
  const incomeAliases = Object.fromEntries(Object.entries({ revenue: aliasMap.revenue, netIncome: aliasMap.netIncome, ebit: aliasMap.ebit, pretaxIncome: aliasMap.pretaxIncome, totalExpenses: aliasMap.totalExpenses, shares: aliasMap.shares }).filter(([, v]) => v));
  const cashflowAliases = Object.fromEntries(Object.entries({ ocf: aliasMap.ocf, capex: aliasMap.capex }).filter(([, v]) => v));
  const balanceSheetAliases = Object.fromEntries(Object.entries({ equity: aliasMap.equity, debt: aliasMap.debt, cash: aliasMap.cash }).filter(([, v]) => v));
  const sharesAliases = Object.fromEntries(Object.entries({ shares: aliasMap.shares }).filter(([, v]) => v));

  for (const filing of filings) {
    let reports;
    try {
      reports = await fetchFilingSummaryReports(cik, filing.accessionNumber, userAgent);
    } catch (e) {
      if (debug) console.error('DEBUG 20-F fetchFilingSummaryReports threw', filing.accessionNumber, e.message);
      continue;
    }
    if (!reports.length) { if (debug) console.error('DEBUG no FilingSummary.xml for 20-F', filing.accessionNumber); continue; }

    const matches = [
      ...(Object.keys(incomeAliases).length ? reports.filter((rep) => STATEMENT_HEADINGS.income.test(rep.shortName) || STATEMENT_HEADINGS.income.test(rep.longName)).map((rep) => ({ rep, aliases: incomeAliases, instant: false })) : []),
      ...(Object.keys(cashflowAliases).length ? reports.filter((rep) => STATEMENT_HEADINGS.cashflow.test(rep.shortName) || STATEMENT_HEADINGS.cashflow.test(rep.longName)).map((rep) => ({ rep, aliases: cashflowAliases, instant: false })) : []),
      ...(Object.keys(balanceSheetAliases).length ? reports.filter((rep) => STATEMENT_HEADINGS.balanceSheet.test(rep.shortName) || STATEMENT_HEADINGS.balanceSheet.test(rep.longName)).map((rep) => ({ rep, aliases: balanceSheetAliases, instant: true })) : []),
      ...(Object.keys(sharesAliases).length ? reports.filter((rep) => STATEMENT_HEADINGS.earningsPerShare.test(rep.shortName) || STATEMENT_HEADINGS.earningsPerShare.test(rep.longName)).map((rep) => ({ rep, aliases: sharesAliases, instant: false })) : []),
    ];

    for (const { rep, aliases, instant } of matches) {
      const accessionNoDashes = filing.accessionNumber.replace(/-/g, '');
      const rUrl = `${SEC_ARCHIVES_BASE}/${Number(cik)}/${accessionNoDashes}/${rep.htmlFileName}`;
      const html = await fetchText(rUrl, userAgent);
      if (debug) console.error('DEBUG 20-F R-file', rUrl, rep.shortName || rep.longName);
      if (!html) continue;
      const $ = cheerio.load(html);

      if (instant) {
        let extractedList;
        try {
          extractedList = extractFromInstantRFile($, aliases);
        } catch (e) {
          if (debug) console.error('DEBUG extractFromInstantRFile (20-F) threw', rUrl, e.message);
          continue;
        }
        if (debug) console.error('DEBUG extractFromInstantRFile (20-F) result', rUrl, JSON.stringify(extractedList));
        recordExtractedInstantAnnual(extractedList, filing);
        continue;
      }

      // Same per-page table search as extractFromRFile -- picks the first
      // substantial table (>=5 rows) that yields a real result, rather than
      // just the literal first <table> on the page (verified live: R-file
      // pages can carry several small formatting/auxiliary tables ahead of
      // the real statement).
      const tables = $('table').toArray();
      for (const table of tables) {
        if ($(table).find('tr').length < 5) continue;
        let extractedList;
        try {
          extractedList = extractAllAnnualColumnsFromTable($, table, aliases);
        } catch (e) {
          if (debug) console.error('DEBUG extractAllAnnualColumnsFromTable threw', rUrl, e.message);
          continue;
        }
        if (extractedList.length) {
          if (debug) console.error('DEBUG extractAllAnnualColumnsFromTable result', rUrl, JSON.stringify(extractedList));
          recordExtractedAnnual(extractedList, filing);
          break;
        }
      }
    }
  }

  // Reconciliation -- same shared machinery the 6-K path uses. Check A
  // (valueCumulative) naturally no-ops for every point here (nothing above
  // ever sets valueCumulative -- an annual column has no shorter cumulative
  // sub-period to reconcile against). Check B (real annual XBRL) and Check
  // C (cross-filing corroboration) apply completely unmodified. Check D
  // (section-subtotal self-check) is the new one -- see its own comment in
  // reconcilePoints.
  const pointsByConcept = new Map();
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
      // hasConflict -- see the sibling collection loop's own comment above
      // (same disagreement risk, same fix, for the 20-F annual path).
      points.push({
        ...rep,
        corroborations: new Set(best.map((o) => o.accessionNumber)).size,
        accessionNumbers: new Set(best.map((o) => o.accessionNumber)),
        hasConflict: byValue.size > 1,
        sectionVerified: best.some((o) => o.sectionVerified),
      });
    }
    points.sort((a, b) => new Date(a.end) - new Date(b.end));
    if (points.length) pointsByConcept.set(concept, points);
    accessionToDatesByConcept.set(concept, accessionToDates);
  }

  const result = {};
  for (const [concept, points] of pointsByConcept) {
    if (debug) console.error('DEBUG 20-F points before reconcile', concept, JSON.stringify(points.map((p) => ({ end: p.end, val: p.val, corroborations: p.corroborations, sectionVerified: p.sectionVerified }))));
    const verified = INSTANT_CONCEPTS.has(concept)
      ? reconcileInstantPoints(points, annualByEnd?.[concept] || new Map(), accessionToDatesByConcept.get(concept), true)
      : reconcilePoints(points, annualByEnd?.[concept] || new Map(), concept, true);
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
// concept's own evidence. Returns { global, perConcept }: `global` sums
// every concept's score together (the original model — correct for the
// common case where one unit convention really does run through the
// whole release, and the only way a concept with no recent annual anchor
// of its own ever gets a sensible scale at all); `perConcept` is a
// Map<concept, scale> holding ONLY the concepts whose OWN evidence (score
// >= 1 at some candidate, independent of every other concept) actually
// disagrees with the global pick — the call site uses this to let that
// one concept's own, stronger signal win instead of inheriting a scale
// that fits everything else in the filing but not it.
//
// Verified live this split is necessary, not just theoretical: ASR's own
// July-2026 6-K earnings release states its income statement (revenue/
// EBIT/net income) in raw pesos but its cash-flow statement specifically
// "$ in Thousands" — a real, same-filing, same-filer mixed-scale
// situation the original single-shared-scale design (see this file's own
// prior comment: "a real filing never mixes 'revenue in millions' with
// 'OCF in thousands' in the same release") assumed could never happen.
// Revenue/EBIT's own strong, consistent signal correctly won the GLOBAL
// vote at scale=1, which then got applied to OCF too, leaving its real
// FY'25 value ~1000x too small (12,348,613 instead of
// 12,348,613,000) — silently producing a near-zero fcfMargin input and,
// since fcfMargin needs BOTH ocf and capex, usually no fcfMargin trend
// published at all.
function detectScaleMultiplier(pointsByConcept, annualByEnd) {
  const scoreByConceptAndScale = new Map(); // concept -> Map<scale, score>
  const recordConceptScore = (concept, scale) => {
    if (!scoreByConceptAndScale.has(concept)) scoreByConceptAndScale.set(concept, new Map());
    const byScale = scoreByConceptAndScale.get(concept);
    byScale.set(scale, (byScale.get(scale) || 0) + 1);
  };
  let bestScale = 1;
  let bestScore = -1;
  for (const scale of SCALE_CANDIDATES) {
    let score = 0;
    for (const [concept, points] of pointsByConcept) {
      // INSTANT_CONCEPTS (equity/debt/cash) excluded from this whole
      // per-concept block, not just the cross-year addition further below
      // -- summing multiple same-year point-in-time SNAPSHOTS and
      // comparing that sum to an annual snapshot is meaningless the way
      // summing quarters of a FLOW concept approximates an annual total
      // (two balance-sheet snapshots added together isn't "the annual
      // balance" at any scale). Verified live: ITRN's own equity snapshots
      // (Dec'25 ~$224M, Jun'26 ~$225M) summed to roughly double the real
      // annual anchor, outside the plausible [30%,105%] band at scale=1 --
      // but this loop's shared `score` is accumulated ACROSS every concept
      // together, so this spurious equity "vote" at some other candidate
      // scale could tip the GLOBAL bestScale decision for the whole
      // filing, corrupting equity/cash/debt's own otherwise-correct values
      // via the later "apply bestScale to every point" step (extra x1000
      // confirmed live: ITRN's correctly-extracted $224,486,000 equity
      // became $224,486,000,000 by the time it reached ROIC's invested-
      // capital calculation, producing an implausible ~0.03% instead of
      // the real ~28%).
      if (INSTANT_CONCEPTS.has(concept)) continue;
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
        // Decumulate nested/overlapping candidates before summing -- same
        // reasoning and same helper as Check B's own fix (see
        // decumulateNestedCandidates' comment); without this, a filer with
        // TNK's hybrid Q1-standalone/H1-9mo-cumulative shape would have its
        // naive overlapping sum never land in any plausible ratio bound at
        // any scale, always concluding "no scaling needed" regardless of
        // whether that's actually true.
        const candidates = decumulateNestedCandidates(byYear.get(fyEndYear) || []);
        if (candidates.length < 2) continue;
        const sum = candidates.reduce((s, p) => s + p.val * scale, 0);
        // Magnitude-only ratio -- capex specifically has a real, known sign
        // mismatch here: text-extracted values stay in their disclosed
        // outflow (negative) convention THROUGHOUT this function (the
        // caller flips the sign to match XBRL's positive-magnitude
        // convention only AFTER receiving the final result), while
        // annualByEnd's real XBRL anchor is already positive. A raw signed
        // ratio (sum / annual.value) is always negative for capex against
        // its own real anchor, permanently failing the plausibility bound
        // regardless of how correct the magnitude is -- verified live:
        // TNK's real 2025 capex sum vs annual anchor is a near-perfect
        // magnitude match (ratio -1.01) but fails outright unsigned.
        // Comparing magnitudes only is safe for same-signed concepts too
        // (abs of two already-matching signs is a no-op).
        const ratio = Math.abs(sum) / Math.abs(annual.value);
        if (process.env.DEBUG_FILING_EXTRACT) console.error('DEBUG detectScaleMultiplier', concept, fyEndYear, 'scale', scale, 'candidates', JSON.stringify(candidates), 'sum', sum, 'annual.value', annual.value, 'ratio', ratio);
        // 2-3 real quarters of a real fiscal year should land roughly in
        // [30%, 105%] of that year's total (generous bounds for
        // seasonality and the possibility all 4 are present) — not a
        // sliver of the year (a scale mismatch) and not wildly over it.
        if (ratio >= 0.3 && ratio <= 1.05) {
          score++;
          recordConceptScore(concept, scale);
        }
      }

      // A SECOND, cross-year comparison for a lone full-fiscal-year point
      // with NO sibling quarters at all -- verified live: ASR's own FY'25
      // revenue comes from a single 6-K earnings-release column (a genuine
      // "months: 12" duration, not a sum of quarters), so the within-year
      // check just above never runs for it (candidates.length is 1, always
      // < 2) and this filing's own real "$ in thousands" scale (confirmed
      // against its own caption) never gets caught -- silently producing
      // a FY'25 figure 1000x too small, computing a -99.9% YoY
      // "collapse" against FY'24's correctly-scaled real XBRL anchor that
      // never actually happened. A single year-over-year ratio can't use
      // the same [30%,105%] band (real YoY swings, even extreme ones like
      // this session's crypto-pivot tickers, can land almost anywhere) --
      // but a genuine 1000x/1000000x scale miss NEVER lands anywhere near
      // 1:1 either, so a much wider [5%, 2000%] band still cleanly
      // separates "real growth/decline" from "wrong scale" without needing
      // to guess a tighter bound per filer. Flow concepts only -- INSTANT_
      // CONCEPTS (equity/debt/cash) excluded: a balance-sheet SNAPSHOT can
      // legitimately swing by more than 20x across a single year (a capital
      // raise, a write-off) with zero scale bug involved, unlike a flow
      // concept's cumulative total, and this file's own INSTANT_CONCEPTS
      // constant already exists exactly to mark that distinction. Verified
      // live this was a real, not hypothetical, false-positive risk: CMBT's
      // own equity/debt/cash data is genuinely messy (many small-cap-style
      // restatements across accessions, several real hasConflict cases) --
      // without this exclusion, noisy instant-concept "votes" swung
      // detectScaleMultiplier's single shared bestScale decision for this
      // filer's ENTIRE extraction pass, corrupting revenue/netIncome/ebit's
      // otherwise-correct values too and wiping out CMBT's yearly data
      // entirely.
      if (INSTANT_CONCEPTS.has(concept)) continue;
      for (const [year, yearPoints] of byYear) {
        if (yearPoints.length !== 1) continue;
        const p = yearPoints[0];
        const durationDays = (new Date(p.end).getTime() - new Date(p.start).getTime()) / (1000 * 60 * 60 * 24);
        if (Math.abs(durationDays - 365) > 20) continue; // not actually a full-year point
        for (const annual of annuals.values()) {
          if (!annual.value || annual.end.slice(0, 4) === year) continue;
          const ratio = Math.abs(p.val * scale) / Math.abs(annual.value);
          if (process.env.DEBUG_FILING_EXTRACT) {
            console.error('DEBUG detectScaleMultiplier crossYear', concept, year, 'vs', annual.end, 'scale', scale, 'val', p.val, 'annual.value', annual.value, 'ratio', ratio);
          }
          if (ratio >= 0.05 && ratio <= 20) {
            score++;
            recordConceptScore(concept, scale);
          }
        }
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestScale = scale;
    }
  }
  const global = bestScore > 0 ? bestScale : 1;

  // Per-concept override: only for a concept whose OWN best-scoring scale
  // (>= 1 real match, same plausibility bands as above — never a guess)
  // actually disagrees with the global pick. A concept with no evidence of
  // its own, or whose own evidence already agrees with global, is left out
  // entirely and falls through to `global` at the call site — same
  // "doesn't vote on its own, inherits the filing's convention" behavior
  // the original design already relied on for a sparse concept.
  const perConcept = new Map();
  for (const [concept, byScale] of scoreByConceptAndScale) {
    let conceptBestScale = null;
    let conceptBestScore = 0;
    for (const [scale, score] of byScale) {
      if (score > conceptBestScore) {
        conceptBestScore = score;
        conceptBestScale = scale;
      }
    }
    if (conceptBestScale != null && conceptBestScale !== global) {
      perConcept.set(concept, conceptBestScale);
    }
  }

  return { global, perConcept };
}

const INSTANT_CONCEPTS = new Set(['equity', 'debt', 'cash']);

// "shares" is a SNAPSHOT (a point-in-time count, effectively an average or
// period-end balance), not a flow -- unlike revenue/netIncome/ocf/capex, it
// is never meaningful to SUM four quarters' share counts and compare that
// sum to an annual figure, and it is nonsensical to derive a "missing
// quarter's" share count as annual-minus-three-known-quarters (there is no
// such thing as an annual share count that decomposes into four additive
// quarterly components). Verified live: this exact confusion corrupted DHT
// -- Check B's derivation (added for genuinely additive concepts) computed
// wildly wrong "shares" values for every Q4 (e.g. large negative numbers)
// by subtracting three real quarterly share counts from an annual figure
// that was never meant to be their sum. reconcilePoints below skips Check
// B's summing/derivation entirely for concepts in this set -- Check A/C/D
// still apply (Check C's cross-filing corroboration in particular is
// exactly the right verification method for a snapshot value).
const NON_ADDITIVE_CONCEPTS = new Set(['shares']);

// No real public company has a weighted-average share count below this --
// used only to decide whether a filer's raw extracted shares value needs
// the SAME dollar-scale correction its other concepts got (see the scale-
// application block above, CNI's real case) or is already a genuine full
// count (STNG's real case) that a blanket correction would over-inflate.
const MIN_PLAUSIBLE_RAW_SHARES = 100000;

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
function reconcileInstantPoints(points, knownByEnd, accessionToDates, trustSingleSource = false) {
  const verified = new Set();
  // See reconcilePoints' own comment on trustSingleSource -- same product
  // decision (now applied to both the 20-F annual AND 6-K quarterly
  // paths), same !hasConflict guard against two independent filings
  // disagreeing on the same period, applied here for balance-sheet
  // (instant) concepts like equity/debt/cash.
  if (trustSingleSource) {
    for (const p of points) if (p.corroborations >= 1 && !p.hasConflict) verified.add(p);
  }
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

// Check B (below) sums every same-fiscal-year candidate and compares
// against the real annual total -- correct when candidates are genuinely
// adjacent, non-overlapping periods, wrong when they're NESTED (multiple
// points sharing the same implicit fiscal-year start but different end
// dates -- e.g. a hybrid filer whose Q1 is a real standalone 3-month
// figure but whose Q2/Q3 are disclosed as H1/9mo CUMULATIVE totals, each
// one containing the shorter ones before it). Verified live: TNK's real
// capex shape is exactly this -- Q1 [Jan 1, Mar 31], H1 [Jan 1, Jun 30],
// 9mo [Jan 1, Sep 30], all sharing the same Jan 1 start -- summing them
// naively (as Check B used to) double/triple-counts Q1 and never matches
// the real annual total, correctly failing to verify even though every
// individual figure is genuinely real. Check A can't help either: it's
// built for a point with BOTH a 3-month figure AND a same-row longer
// cumulative column in the SAME document -- this shape only ever shows
// the cumulative column alone, no adjacent 3-month column to check
// against in the same row.
//
// Derives the real non-overlapping standalone sub-periods via subtraction
// -- same principle as dedupeAndClassify's own H1-Q1/9mo-H1 decumulation
// in generateForeignFilingsCache.js, applied one layer earlier so Check B
// can evaluate a correct, summable candidate set. Deliberately NOT
// switching to a magnitude/ratio plausibility check instead (e.g. "a
// 9-month figure should be roughly 60-90% of the annual total") -- that
// would be a real precision regression from the "exact arithmetic match,
// never estimate" principle every other check here already holds to.
//
// Returns a REPLACEMENT (non-overlapping) candidate set for summing --
// for a nested family, only the shortest original point (e.g. Q1) plus
// synthetic deltas between each subsequent pair (H1-Q1, 9mo-H1) are kept,
// never the longer originals themselves (those would still overlap the
// derived deltas). A point with a unique start (not part of any nested
// family -- the common, already-correct case) passes through unchanged.
// The synthetic deltas exist ONLY to make Check B's sum-vs-annual-total
// arithmetic come out right -- they are NEVER what gets marked verified
// or returned (see the call site below): once Check B confirms the real
// underlying points (Q1, H1, 9mo) are mutually consistent with the real
// annual total, those REAL points flow back to the caller exactly as
// disclosed, and dedupeAndClassify's own already-proven decumulation logic
// independently re-derives the same standalone quarters downstream --
// this function's job is only to let Check B correctly SEE that the real
// points are trustworthy, not to duplicate the decumulation itself.
function decumulateNestedCandidates(points) {
  // Groups by APPROXIMATE start (within isAdjacentDate's own tolerance),
  // not exact string equality -- verified live this matters: subtractMonths'
  // calendar-month arithmetic doesn't land on the exact same synthetic
  // date for different durations from the same real fiscal-year start
  // (e.g. TNK's Q1 2023, ending Mar 31, synthesizes a start of
  // "2022-12-31", while its 9mo 2023, ending Sep 30, synthesizes
  // "2022-12-30" -- one calendar day apart, same underlying fiscal year).
  // An exact-match grouping never recognized these as the same nested
  // family at all, silently making this whole function a no-op for the
  // motivating case. Small (O(n^2)) clustering is fine given at most a
  // handful of candidates per fiscal year.
  const groups = [];
  for (const p of points) {
    const group = groups.find((g) => isAdjacentDate(g[0].start, p.start));
    if (group) group.push(p);
    else groups.push([p]);
  }
  const result = [];
  for (const group of groups) {
    if (group.length === 1) {
      result.push(group[0]);
      continue;
    }
    const sorted = [...group].sort((a, b) => new Date(a.end) - new Date(b.end));
    result.push(sorted[0]); // shortest kept as-is (e.g. the real standalone Q1)
    for (let i = 1; i < sorted.length; i++) {
      const shorter = sorted[i - 1];
      const longer = sorted[i];
      result.push({
        start: shorter.end,
        end: longer.end,
        val: longer.val - shorter.val,
        derivedFrom: [shorter, longer],
      });
    }
  }

  // Second pass: a derived remainder above can still fully or partially
  // overlap OTHER, independently-disclosed standalone points that landed in
  // a DIFFERENT start-group above -- adjacent quarters (Q2, Q3, ...) don't
  // share a start with the fiscal-year-origin group (Q1/annual), so pass 1
  // never recognizes them as related. Verified live: AGI (a Canadian gold
  // miner) discloses real standalone Q1, Q2, AND Q3 revenue (each its own
  // "Three Months Ended" column, in three separate 6-K filings), plus a
  // real annual XBRL total. Pass 1 only pairs Q1 with the annual total
  // (both start near Jan 1), producing a 9-month "remainder" that actually
  // still CONTAINS the real, separately-grouped Q2 and Q3 -- naively
  // summing everything then triple-counts Q2/Q3, overshooting the real
  // annual total by ~50% at every scale candidate, which made
  // detectScaleMultiplier/Check B fail outright for every concept. This
  // walks forward from a "wide" point's own start, chaining any OTHER
  // points that are adjacent and fall entirely within its range (the exact
  // same "value = wide total - known piece" principle pass 1 already
  // applies within a single start-group, just not limited to that group),
  // and narrows the wide point down to the genuine residual gap -- or drops
  // it entirely if the known pieces already tile its whole range. A no-op
  // for the common case (no cross-group overlap), so this can't regress a
  // ticker that never had this shape to begin with.
  //
  // MAX_NARROW_ITERATIONS is a hard safety valve, not a normal control-flow
  // bound -- verified live this is a REAL, not theoretical, risk: GIL
  // (Gildan Activewear, 25 years of 40-F/6-K filings -- an order of
  // magnitude more candidate points per concept than a typical filer this
  // was designed against) OOM-crashed the whole pipeline (confirmed via
  // local reproduction: RSS climbed from ~330MB to 2GB+ in under 3 minutes,
  // no plateau) because this loop restarts its ENTIRE scan from scratch on
  // every single mutation, and for a large-enough candidate set with real,
  // messy overlap (restated/re-disclosed figures across dozens of filings),
  // it never reliably reaches a fixed point where nothing narrows further.
  // Each restart also allocates a new object whose `derivedFrom` chains
  // back through every prior iteration, so a stuck loop grows memory, not
  // just CPU time. Bounded relative to input size (every point should need
  // narrowing at most a small constant number of times in the sane case
  // this was actually designed for) so normal filers are completely
  // unaffected -- hitting the cap just means whatever's left unresolved
  // stays as-is and falls through to reconcilePoints' own checks below,
  // same as if pass 2 had never run at all (safe: this can only mean a
  // point that COULD have been recovered doesn't get published, never that
  // something wrong gets published).
  const MAX_NARROW_ITERATIONS = Math.max(50, points.length * 4);
  let narrowIterations = 0;
  let narrowed = true;
  while (narrowed) {
    narrowed = false;
    if (++narrowIterations > MAX_NARROW_ITERATIONS) {
      console.error(`decumulateNestedCandidates: hit MAX_NARROW_ITERATIONS (${MAX_NARROW_ITERATIONS}) with ${result.length} points remaining -- stopping early rather than risk an unbounded loop.`);
      break;
    }
    for (const wide of result) {
      const others = result.filter((p) => p !== wide);
      let cursor = wide.start;
      let sum = 0;
      const used = [];
      for (;;) {
        const next = others.find(
          (p) => !used.includes(p) && isAdjacentDate(cursor, p.start) && new Date(p.end) <= new Date(wide.end)
        );
        if (!next) break;
        used.push(next);
        sum += next.val;
        cursor = next.end;
      }
      if (!used.length) continue;
      if (isAdjacentDate(cursor, wide.end)) {
        result.splice(result.indexOf(wide), 1);
      } else {
        result.splice(result.indexOf(wide), 1, { start: cursor, end: wide.end, val: wide.val - sum, derivedFrom: [wide, ...used] });
      }
      narrowed = true;
      break; // result mutated -- restart the scan
    }
  }
  return result;
}

function reconcilePoints(points, annualByEnd, concept, trustSingleSource = false) {
  const verified = new Set();

  // Check D — same-document section-subtotal self-check (20-F annual
  // extraction only -- see extractAllAnnualColumnsFromTable's own comment).
  // A newly-recovered fiscal year with no second filing to cross-corroborate
  // it via Check C yet (e.g. a company's most recent 20-F, filed once,
  // comparative years not yet echoed by a future filing) would otherwise
  // stay unverified for up to a year. If every numeric row in this point's
  // own section summed to that section's own disclosed subtotal at
  // extraction time, the document already corroborates itself -- no
  // arithmetic assumption beyond what the filer itself disclosed.
  for (const p of points) if (p.sectionVerified) verified.add(p);

  // trustSingleSource -- originally set ONLY by the 20-F annual path (a
  // fact pulled from the issuer's own official annual report, structured
  // XBRL, is reliable on its own). Now ALSO passed by the 6-K quarterly
  // path's own call site, per a second explicit product decision: Check A
  // (same-document cumulative self-check, just above) was tried first as
  // the safer alternative, but verified live it structurally cannot help
  // a filer like ASR, which only ever discloses ONE standalone quarter per
  // year (its H1 release breaks out Q2 alone, no Q1/Q3/Q4 counterpart ever
  // disclosed) -- Check A's sum-of-consecutive-quarters logic needs at
  // least 2 real quarters to chain, so a single quarter can never
  // self-verify no matter how correctly it's extracted. Trusting a single
  // 6-K extraction is a real step down in safety vs. the 20-F case (free-
  // text/HTML parsing, not structured XBRL -- this file's own history this
  // session includes several real extraction bugs that would have
  // silently published a wrong number under the old >=2 bar's protection),
  // accepted knowingly to unblock filers like ASR/PAC rather than leave
  // them waiting up to a year for a second filing to happen to repeat the
  // same figure.
  if (trustSingleSource) {
    for (const p of points) if (p.corroborations >= 1 && !p.hasConflict) verified.add(p);
  }

  // Check C — cross-filing corroboration: the SAME real value for this
  // exact period was independently disclosed in 2+ separate 6-K filings
  // (e.g. as this year's own current-quarter figure, and again a year
  // later as the prior-year comparative column). No arithmetic assumption
  // at all — just literal agreement between independent real documents.
  // Now redundant whenever trustSingleSource is true (every current
  // caller) since corroborations >= 1 already covers everything this
  // would also verify -- kept as the fallback bar for any future caller
  // that passes trustSingleSource = false. Originally verified live this
  // was necessary, not just nice-to-have: DEFT and CMBT (and most of this
  // bucket) only ever disclose ONE standalone quarter per fiscal year with
  // no same-document cumulative column, so Check A (needs a cumulative
  // column) and Check B (needs 2+ quarters in the SAME fiscal year) could
  // never verify them under the old, stricter default.
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
  // hasConflict points excluded on both sides -- see Check B's own comment
  // below for why a disputed point shouldn't be trusted just because some
  // arithmetic happens to work out, same principle applied here: neither
  // the point being verified NOR a prior quarter propping up its chain
  // sum should be an actively-disputed value.
  for (const p of points) {
    if (p.valueCumulative == null || p.hasConflict) continue;
    const chain = [p];
    let cursor = p;
    for (;;) {
      const prior = points.find((q) => !chain.includes(q) && !q.hasConflict && isAdjacentDate(q.end, cursor.start));
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
  // Points derived below (currently just the single-missing-quarter case
  // right after this comment) aren't part of the original `points` array,
  // so `points.filter((p) => verified.has(p))` at the end of this function
  // could never return them even if added to `verified` -- collected here
  // and appended to the final return explicitly instead.
  const derivedPointsToPublish = [];
  if (annualByEnd.size && !NON_ADDITIVE_CONCEPTS.has(concept)) {
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
      // hasConflict excluded here too -- verified live: DEFT's disputed
      // Q1'25 (two different 6-Ks disclose two different "Total revenues"
      // figures for the same period, see hasConflict's own comment above)
      // was slipping through THIS check even with the trustSingleSource/
      // Check C guards in place, since Check B verifies by whole-fiscal-
      // year SUM against the real annual XBRL total, with no awareness of
      // any individual quarter's own provenance. A disputed point summed
      // in here can make an otherwise-correct year's total look right (or
      // wrong) for reasons having nothing to do with whether THIS quarter
      // itself is trustworthy -- excluding it is the same "don't trust an
      // actively-disputed value just because the arithmetic happens to
      // work out" principle as trustSingleSource's own guard, applied to
      // this separate, pre-existing (not new today) verification path.
      const rawCandidates = (byYear.get(fyEndYear) || [])
        .filter((p) => !p.hasConflict)
        .filter((p) => p.end <= annual.end && new Date(p.start).getTime() >= new Date(annual.start).getTime() - startToleranceMs);
      // Decumulate nested/overlapping periods (see decumulateNestedCandidates'
      // own comment) before summing -- a no-op for the common case where
      // every candidate already has a unique start.
      const candidates = decumulateNestedCandidates(rawCandidates);
      // Derive a single missing quarter (in practice almost always Q4)
      // via pure subtraction against the real annual total, when the
      // OTHER three quarters of this fiscal year are already known and
      // mutually adjacent with no internal gap. Verified live this is a
      // real, common shape (not hypothetical): CAAP's 6-K earnings
      // releases never disclose a discrete Q4/full-year-minus-9-months
      // exhibit for ANY concept, in ANY fiscal year -- Q4 results are only
      // ever folded into the annual 20-F, so Check B would otherwise
      // permanently fail (short by exactly one quarter, every single
      // year) despite Q1-Q3 all being individually real and correct. Only
      // fires for EXACTLY 3 known candidates -- deriving from 2 or fewer
      // would be underdetermined (more than one unknown quarter, only one
      // equation available), so this deliberately doesn't try to guess
      // which of two gaps is which.
      if (candidates.length === 3) {
        const sorted = [...candidates].sort((a, b) => new Date(a.start) - new Date(b.start));
        const contiguous = isAdjacentDate(sorted[0].end, sorted[1].start) && isAdjacentDate(sorted[1].end, sorted[2].start);
        const startsAtFyBegin = new Date(sorted[0].start).getTime() >= new Date(annual.start).getTime() - startToleranceMs;
        const endsBeforeFyEnd = sorted[2].end < annual.end;
        if (contiguous && startsAtFyBegin && endsBeforeFyEnd) {
          const knownSum = sorted.reduce((s, p) => s + p.val, 0);
          // Magnitude-only arithmetic here too -- same real sign-convention
          // mismatch Check B's own comparison below already tolerates
          // (capex's text-extracted quarters stay in their disclosed
          // outflow/negative convention, while annualByEnd's XBRL anchor is
          // often a positive magnitude). A raw signed `annual.value -
          // knownSum` silently ADDS the two instead of subtracting whenever
          // the signs disagree -- verified live: this produced a nonsense,
          // wrong-sign "derived Q4" for DHT (a real annual anchor that
          // turned out to be an unrelated, differently-signed concept
          // entirely -- see the magnitude guard below, which is what
          // actually catches that case). Derives a MAGNITUDE, then applies
          // the same sign the three known quarters already share (safe --
          // they come from the same extraction pass/convention).
          const derivedMagnitude = Math.abs(annual.value) - Math.abs(knownSum);
          // A negative derived magnitude means the three "known" quarters
          // already exceed the annual total on their own -- impossible for
          // a real 4th quarter, and a strong signal this annual figure
          // isn't actually the same concept as these quarters at all (not
          // just a units/sign mismatch). Bail rather than fabricate a
          // number Check B would otherwise wrongly wave through as a
          // trivial (self-constructed) exact match.
          if (derivedMagnitude > 0) {
            const sign = knownSum < 0 ? -1 : 1;
            const derivedLastQuarter = {
              start: sorted[2].end,
              end: annual.end,
              val: sign * derivedMagnitude,
              filed: sorted.reduce((latest, p) => (p.filed > latest ? p.filed : latest), sorted[0].filed),
            };
            candidates.push(derivedLastQuarter);
            derivedPointsToPublish.push(derivedLastQuarter);
          }
        }
      }
      if (candidates.length < 2) continue; // too little to meaningfully reconcile
      const sum = candidates.reduce((s, p) => s + p.val, 0);
      // Magnitude-only comparison -- same real sign-convention mismatch as
      // detectScaleMultiplier's own ratio above: capex's text-extracted sum
      // stays in its disclosed outflow (negative) convention here, while
      // annualByEnd's real XBRL anchor is already positive. A raw signed
      // diff (sum - annual.value) effectively DOUBLES the true magnitude
      // gap for capex specifically, permanently failing this check
      // regardless of how correct the extraction is. Safe for same-signed
      // concepts too (their existing relationship is unchanged by abs()).
      const diff = Math.abs(Math.abs(sum) - Math.abs(annual.value)) / Math.abs(annual.value);
      if (process.env.DEBUG_FILING_EXTRACT) console.error('DEBUG CheckB', fyEndYear, 'rawCandidates', JSON.stringify(rawCandidates), 'candidates', JSON.stringify(candidates), 'sum', sum, 'annual.value', annual.value, 'diff', diff);
      if (diff <= RECONCILE_TOLERANCE) {
        // A synthetic candidate (derivedFrom set) only exists to make the
        // sum arithmetic come out right -- it's never itself part of
        // `points`, so marking IT verified would do nothing (the final
        // `points.filter((p) => verified.has(p))` below couldn't find it).
        // Mark its REAL underlying originals verified instead; a plain
        // (non-derived) candidate is already a real point from `points`.
        for (const c of candidates) {
          if (c.derivedFrom) c.derivedFrom.forEach((src) => verified.add(src));
          else verified.add(c);
        }
      }
    }
  }

  return [...points.filter((p) => verified.has(p)), ...derivedPointsToPublish];
}

module.exports = {
  parseNumericCell,
  isYearCell,
  parsePeriodPhrase,
  parseTableColumns,
  parseDataRow,
  extractStatement,
  extractMdaCashFlowSummary,
  subtractThreeMonths,
  monthDayYearToIso,
  reconcilePoints,
  reconcileInstantPoints,
  detectScaleMultiplier,
  parseInstantTableColumns,
  extractFromInstantTable,
  extractInstantStatement,
  extractQuarterlyFactsFromFilings,
  extractAllAnnualColumnsFromTable,
  extractFromInstantRFile,
  extractAnnualFactsFrom20F,
  resolveConceptCandidates,
  throttleSecRequest,
  isAdjacentDate,
  computeCumulativeFallbackConcepts,
};
