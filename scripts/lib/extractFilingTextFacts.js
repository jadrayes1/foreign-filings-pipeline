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
const MAX_FILINGS_TO_SCAN = 25; // ~2 years of quarters
const MIN_EXHIBIT_BYTES = 20000; // cover-page heuristic — verified live: STNG's 6-K cover page was 11,450 bytes, its real earnings exhibit 733,171 bytes
const RECONCILE_TOLERANCE = 0.02; // 2%

// "Earnings" as an income-statement synonym verified live: CNQ titles its
// real income statement "CONSOLIDATED STATEMENTS OF EARNINGS" (distinct
// from its separate "...OF COMPREHENSIVE INCOME" table, which only carries
// OCI reconciliation items — no revenue line at all. Matching both is safe
// since extractStatement already tries every heading match in a document
// in order and moves on if a match yields no line-item hits.
const STATEMENT_HEADINGS = {
  income: /CONSOLIDATED (STATEMENTS? OF (COMPREHENSIVE )?INCOME|STATEMENTS? OF OPERATIONS|STATEMENTS? OF EARNINGS|INCOME STATEMENTS?)/i,
  cashflow: /CONSOLIDATED STATEMENTS? OF CASH ?FLOWS/i,
};

// Text-label aliases, matched against a data row's leading (non-numeric)
// cell text. Deliberately conservative — IFRS/press-release line-item
// naming varies far more than XBRL concept names do, so ambiguous matches
// are skipped rather than guessed (see findLineItem below).
const LABEL_ALIASES = {
  // Prefix match (not anchored with $) — verified live AEM labels its top
  // revenue line "Revenues from mining operations" (a descriptive suffix
  // after "Revenues", not a sub-total line), unlike net income, which
  // commonly has a genuinely DIFFERENT, wrong sub-line ("...attributable
  // to non-controlling interests") that a loose match would wrongly grab —
  // kept exact-match there instead. A stray revenue sub-line with a similar
  // prefix elsewhere in the same statement would still resolve as
  // AMBIGUOUS (see extractStatement) and get dropped, not guessed.
  revenue: /^(total |net |operating |vessel )?revenues?\b/i,
  netIncome: /^net (income|earnings)(\s*\(loss\))?$/i,
  ocf: /^net cash (from|provided by|generated from)( \(used in\))? operating activities/i,
  capex: /^(capital expenditures|purchase(s)? of property,? plant)/i,
};

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

async function fetchWithTimeout(url, options) {
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

function isYearCell(text) {
  return /^(19|20)\d{2}$/.test(text.trim());
}

function nonEmptyCells($, row) {
  return $(row)
    .find('td,th')
    .toArray()
    .map((c) => ({ text: $(c).text().replace(/\s+/g, ' ').trim(), colspan: parseInt($(c).attr('colspan') || '1', 10) }))
    .filter((c) => c.text.length > 0);
}

// "For the three months ended June 30," -> {months: 3, endMonthDay: 'June 30'}
// A period-length phrase doesn't always carry its own date inline though —
// verified live: CNQ's period row just says "Three Months Ended"/"Six
// Months Ended" with the date living in the NEXT row's cells instead (see
// parseDateHeaderCell below) — endMonthDay is null in that case, filled in
// from the date row instead.
function parsePeriodPhrase(text) {
  const months = /nine months|9 months/i.test(text) ? 9 : /six months|6 months/i.test(text) ? 6 : /three months|3 months/i.test(text) ? 3 : null;
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
  if (isYearCell(text)) return { year: text, monthDay: null };
  const compound = text.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s*((?:19|20)\d{2})$/);
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
function parseTableColumns($, table) {
  const rows = $(table).find('tr').toArray();
  let periodPhrases = null;
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
      const bareDateCell = cells.find((c) => /(period|quarter) ended\s+[A-Za-z]+\s+\d{1,2}/i.test(c.text) && !/months? ended/i.test(c.text));
      if (bareDateCell) {
        const dateMatch = bareDateCell.text.match(/ended\s+([A-Za-z]+\s+\d{1,2})/i);
        const yearCellsInSameRow = cells.filter((c) => isYearCell(c.text)).map((c) => c.text);
        if (dateMatch && yearCellsInSameRow.length >= 2) {
          const columns = yearCellsInSameRow.map((year) => ({ months: 3, endMonthDay: dateMatch[1], year }));
          return { columns, dataStartRowIdx: i + 1 };
        }
      }
    }

    if (!periodPhrases) {
      const phraseCells = cells.filter((c) => /months? ended/i.test(c.text));
      if (phraseCells.length) {
        const parsed = phraseCells.map((c) => parsePeriodPhrase(c.text)).filter(Boolean);
        if (parsed.length) periodPhrases = parsed;
      }
      continue;
    }
    const dateCells = cells.map((c) => parseDateHeaderCell(c.text)).filter(Boolean);
    if (dateCells.length >= 2) {
      if (dateCells.length % periodPhrases.length !== 0) continue; // malformed — try a later row rather than guess
      const yearsPerPeriod = dateCells.length / periodPhrases.length;
      const columns = dateCells.map((date, idx) => {
        const phrase = periodPhrases[Math.floor(idx / yearsPerPeriod)];
        const endMonthDay = date.monthDay || phrase.endMonthDay;
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

// Locates a statement's heading + immediately-following <table>, parses its
// columns, and extracts every matched line item — returning both the
// TARGET 3-month column's value per concept AND, when present, that same
// row's own 6-month/9-month column value for the SAME fiscal year (used
// for within-filing reconciliation by the caller — no separate lookup
// needed since it's the same row, just a different column).
function extractStatement($, headingRegex, targetEndYear, aliasMap) {
  const allEls = $('body *').toArray();
  const headingIdxs = [];
  for (let i = 0; i < allEls.length; i++) {
    if ($(allEls[i]).children().length === 0 && headingRegex.test($(allEls[i]).text())) headingIdxs.push(i);
  }
  // A heading can appear more than once (verified live: IAG's financial-
  // statements exhibit has a table-of-contents entry using the exact same
  // heading text before the real statement) — try each occurrence in order
  // and use the first one that actually yields a parseable table, rather
  // than assuming the first match is the real statement.
  for (const headingIdx of headingIdxs) {
    let table = null;
    for (let i = headingIdx; i < allEls.length; i++) {
      if (allEls[i].tagName === 'table') {
        table = allEls[i];
        break;
      }
    }
    if (!table) continue;

    const parsed = parseTableColumns($, table);
    if (!parsed) continue;
    const { columns, dataStartRowIdx } = parsed;

    const targetIdx3mo = columns.findIndex((c) => c.months === 3 && c.year === targetEndYear);
    if (targetIdx3mo === -1) continue; // this filing doesn't cover the quarter we're after
    const targetPeriod = columns[targetIdx3mo];
    // Same fiscal year's cumulative (6mo/9mo) column, if this table has one —
    // used for the within-filing reconciliation check.
    const cumulativeIdx = columns.findIndex((c) => c.months > 3 && c.year === targetEndYear);

    const rows = $(table).find('tr').toArray();
    const results = {};
    for (let i = dataStartRowIdx; i < rows.length; i++) {
      const cells = nonEmptyCells($, rows[i]);
      if (!cells.length) continue;
      const row = parseDataRow(cells, columns.length);
      if (!row) continue;
      for (const [concept, aliasRegex] of Object.entries(aliasMap)) {
        if (!aliasRegex.test(row.label)) continue;
        if (results[concept]) {
          // Ambiguous — a second line in the same statement also matches this
          // concept's alias. Never guess which is right; drop the concept
          // for this filing entirely.
          results[concept] = 'AMBIGUOUS';
          continue;
        }
        results[concept] = {
          value3mo: row.values[targetIdx3mo],
          valueCumulative: cumulativeIdx !== -1 ? row.values[cumulativeIdx] : null,
        };
      }
    }
    for (const key of Object.keys(results)) {
      if (results[key] === 'AMBIGUOUS') delete results[key];
    }
    if (Object.keys(results).length) return { period: targetPeriod, facts: results };
  }
  return null;
}

function subtractThreeMonths(dateStr) {
  const d = new Date(dateStr);
  const result = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 3, d.getUTCDate()));
  return result.toISOString().slice(0, 10);
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
  for (let i = 0; i < r.form.length && filings.length < MAX_FILINGS_TO_SCAN; i++) {
    if (r.form[i] === '6-K') {
      filings.push({ accessionNumber: r.accessionNumber[i], filingDate: r.filingDate[i] });
    }
  }

  // concept -> Map(end -> {value3mo, valueCumulative, start, filed})
  const collected = { revenue: new Map(), netIncome: new Map(), ocf: new Map(), capex: new Map() };
  const aliasMap = {};
  for (const c of neededConcepts) if (LABEL_ALIASES[c]) aliasMap[c] = LABEL_ALIASES[c];

  // Set DEBUG_FILING_EXTRACT=1 to trace discovery/extraction per filing —
  // useful when diagnosing why a specific ticker isn't producing results
  // during the staged manual rollout (see the plan's "Rollout" section).
  const debug = !!process.env.DEBUG_FILING_EXTRACT;

  for (const filing of filings) {
    let exhibitUrls;
    try {
      exhibitUrls = await fetchExhibitCandidates(cik, filing, userAgent);
    } catch (e) {
      if (debug) console.error('DEBUG fetchExhibitCandidates threw', filing.accessionNumber, e.message);
      continue;
    }
    if (debug) console.error('DEBUG', filing.accessionNumber, 'candidates:', exhibitUrls);
    await sleep(150);

    for (const url of exhibitUrls) {
      let html;
      try {
        html = await fetchText(url, userAgent);
      } catch (e) {
        if (debug) console.error('DEBUG fetchText threw', url, e.message);
        continue;
      }
      await sleep(150);
      if (!html) { if (debug) console.error('DEBUG empty html', url); continue; }
      const $ = cheerio.load(html);
      const fullText = $('body').text();
      const hasIncome = STATEMENT_HEADINGS.income.test(fullText);
      const hasCashflow = STATEMENT_HEADINGS.cashflow.test(fullText);
      if (debug) console.error('DEBUG', url, 'hasIncome', hasIncome, 'hasCashflow', hasCashflow);
      if (!hasIncome && !hasCashflow) continue;

      // Try every year we might plausibly need (this filing's own filing
      // year and the one prior) rather than assuming which quarter it covers.
      const candidateYears = [String(new Date(filing.filingDate).getUTCFullYear()), String(new Date(filing.filingDate).getUTCFullYear() - 1)];

      for (const heading of [STATEMENT_HEADINGS.income, STATEMENT_HEADINGS.cashflow]) {
        const incomeAliases = { revenue: aliasMap.revenue, netIncome: aliasMap.netIncome };
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
          if (!extracted) continue;
          const endIso = monthDayYearToIso(extracted.period.endMonthDay, extracted.period.year);
          if (!endIso) continue;
          const startIso = subtractThreeMonths(endIso);
          for (const [concept, fact] of Object.entries(extracted.facts)) {
            if (!collected[concept].has(endIso)) {
              collected[concept].set(endIso, {
                start: startIso,
                end: endIso,
                val: fact.value3mo,
                valueCumulative: fact.valueCumulative,
                filed: filing.filingDate,
              });
            }
          }
        }
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
  const result = {};
  for (const concept of neededConcepts) {
    const points = Array.from(collected[concept]?.values() || []).sort((a, b) => new Date(a.end) - new Date(b.end));
    if (!points.length) continue;
    const verified = reconcilePoints(points, annualByEnd?.[concept] || new Map());
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

function reconcilePoints(points, annualByEnd) {
  const verified = new Set();

  // Check A — consecutive pair vs. this point's own disclosed cumulative.
  for (const p of points) {
    if (p.valueCumulative == null) continue;
    const prior = points.find((q) => q !== p && isAdjacentDate(q.end, p.start));
    if (!prior || !p.valueCumulative) continue;
    const sum = prior.val + p.val;
    const diff = Math.abs(sum - p.valueCumulative) / Math.abs(p.valueCumulative);
    if (diff <= RECONCILE_TOLERANCE) {
      verified.add(p);
      verified.add(prior);
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
      const candidates = (byYear.get(fyEndYear) || []).filter((p) => p.end <= annual.end && p.start >= annual.start);
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
  extractQuarterlyFactsFromFilings,
};
