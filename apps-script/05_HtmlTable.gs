/**
 * ============================================================================
 * 05_HtmlTable.gs — tolerant table extraction from real-world email HTML.
 * ============================================================================
 * Real emails are not clean documents. This module survives:
 *   - Gmail/Outlook layout tables wrapped around the real table (nesting)
 *   - signatures that themselves contain tables
 *   - colspan / rowspan
 *   - missing </td>, missing </tr>, uppercase tags, inline styles
 *   - multiple report tables in one email
 *   - blank rows and blank trailing columns
 *   - plain-text "a | b | c" tables when there is no HTML at all
 *
 * Output contract:
 *   extractTables_(html) -> [ { index, rows: [ [ {text, href}, ... ], ... ] } ]
 * ============================================================================
 */

function stripNoise_(html) {
  return String(html || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<head[\s\S]*?<\/head>/gi, ' ');
}

/** All table blocks, innermost included, ordered by position in the document. */
function findTableBlocks_(html) {
  const re = /<\/?table\b[^>]*>/gi;
  var m, stack = [], blocks = [];
  while ((m = re.exec(html)) !== null) {
    if (m[0].charAt(1) !== '/') {
      stack.push(m.index + m[0].length);
    } else {
      var start = stack.pop();
      if (start !== undefined && m.index > start) {
        blocks.push({ start: start, inner: html.substring(start, m.index) });
      }
    }
  }
  // unclosed <table> at end of document — take the remainder
  while (stack.length) {
    var s = stack.pop();
    blocks.push({ start: s, inner: html.substring(s) });
  }
  blocks.sort(function (a, b) { return a.start - b.start; });
  return blocks;
}

/** Removes complete nested <table>...</table> subtrees from a table's inner HTML. */
function stripNestedTables_(inner) {
  const re = /<\/?table\b[^>]*>/gi;
  var m, depth = 0, out = '', cursor = 0, blockStart = -1;
  while ((m = re.exec(inner)) !== null) {
    if (m[0].charAt(1) !== '/') {
      if (depth === 0) { out += inner.substring(cursor, m.index); blockStart = m.index; }
      depth++;
    } else if (depth > 0) {
      depth--;
      if (depth === 0) { cursor = m.index + m[0].length; blockStart = -1; }
    }
  }
  out += inner.substring(depth === 0 ? cursor : (blockStart >= 0 ? blockStart : cursor));
  return out;
}

function tagText_(fragment) {
  return cleanWhitespace_(decodeEntities_(
    String(fragment)
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<\/?(p|div|li|tr)\b[^>]*>/gi, ' ')
      .replace(/<[^>]*>/g, '')
  ));
}

function firstHref_(fragment) {
  var m = String(fragment).match(/<a\b[^>]*href\s*=\s*["']([^"']+)["']/i);
  if (m) return decodeEntities_(m[1]);
  var t = tagText_(fragment);
  var u = t.match(/https?:\/\/\S+/);
  return u ? u[0].replace(/[),.]+$/, '') : '';
}

function attrNum_(tag, name) {
  var m = new RegExp(name + '\\s*=\\s*["\']?(\\d+)', 'i').exec(tag);
  var n = m ? parseInt(m[1], 10) : 1;
  return (isNaN(n) || n < 1 || n > 50) ? 1 : n;
}

/** Parses one table's inner HTML (nested tables already stripped) into a grid. */
function parseTableRows_(inner) {
  const rowChunks = [];
  const trRe = /<tr\b[^>]*>([\s\S]*?)(?=<tr\b|<\/table>|$)/gi;
  var m;
  while ((m = trRe.exec(inner)) !== null) rowChunks.push(m[1]);
  if (!rowChunks.length) return [];

  const grid = [];
  const pending = {};   // colIndex -> {cell, remaining}  (rowspan carry-down)

  rowChunks.forEach(function (chunk) {
    const cells = [];
    var c = 0;
    // place any carried rowspan cells first
    function placeCarried() {
      while (pending[c] && pending[c].remaining > 0) {
        cells[c] = { text: pending[c].cell.text, href: pending[c].cell.href };
        pending[c].remaining--;
        if (pending[c].remaining <= 0) delete pending[c];
        c++;
      }
    }
    placeCarried();

    const cellRe = /<(t[dh])\b([^>]*)>([\s\S]*?)(?=<t[dh]\b|<\/tr>|<\/t[dh]>\s*<\/table>|$)/gi;
    var cm;
    while ((cm = cellRe.exec(chunk)) !== null) {
      var attrs = cm[2] || '';
      var body = cm[3].replace(/<\/t[dh]>[\s\S]*$/i, '');
      var cell = { text: tagText_(body), href: firstHref_(body) };
      var colspan = attrNum_(attrs, 'colspan');
      var rowspan = attrNum_(attrs, 'rowspan');
      for (var k = 0; k < colspan; k++) {
        placeCarried();
        cells[c] = { text: cell.text, href: cell.href };
        if (rowspan > 1) pending[c] = { cell: cell, remaining: rowspan - 1 };
        c++;
      }
    }
    for (var i = 0; i < cells.length; i++) if (!cells[i]) cells[i] = { text: '', href: '' };
    grid.push(cells);
  });

  // drop fully blank rows
  return grid.filter(function (r) {
    return r.some(function (c) { return c && c.text; });
  });
}

function extractTables_(html) {
  const clean = stripNoise_(html);
  const blocks = findTableBlocks_(clean);
  const out = [];
  blocks.forEach(function (b) {
    const rows = parseTableRows_(stripNestedTables_(b.inner));
    if (rows.length) out.push({ index: out.length, rows: rows, source: 'html' });
  });
  return out;
}

/**
 * Plain-text fallback: contiguous lines containing "|" become a table.
 * Handles the exact acceptance-test format:  Date | Employee | Task | Status | Link
 */
function extractPipeTables_(text) {
  const lines = String(text || '').split(/\r?\n/);
  const tables = [];
  var buf = [];
  function flush() {
    const rows = buf.filter(function (l) { return !/^[\s|:+-]+$/.test(l); })
      .map(function (l) {
        var parts = l.split('|').map(function (p) { return cleanWhitespace_(p); });
        if (parts.length && parts[0] === '') parts.shift();
        if (parts.length && parts[parts.length - 1] === '') parts.pop();
        return parts.map(function (p) {
          var u = p.match(/https?:\/\/\S+/);
          return { text: p, href: u ? u[0] : '' };
        });
      })
      .filter(function (r) { return r.length >= 2 && r.some(function (c) { return c.text; }); });
    if (rows.length >= 2) tables.push({ index: tables.length, rows: rows, source: 'text' });
    buf = [];
  }
  lines.forEach(function (l) {
    if ((l.match(/\|/g) || []).length >= 2) buf.push(l);
    else { if (buf.length) flush(); }
  });
  if (buf.length) flush();
  return tables;
}

/**
 * Finds the header row inside a grid and returns the column map.
 * Returns null when the table is not a report table (signature, layout, etc.).
 */
function mapHeaderRow_(rows) {
  const cfg = getConfig();
  const scanLimit = Math.min(rows.length, 6);
  for (var r = 0; r < scanLimit; r++) {
    const mapping = {};
    var matches = 0;
    rows[r].forEach(function (cell, i) {
      const field = Masters.normalizeHeader(cell.text);
      if (field && !(field in mapping)) { mapping[field] = i; matches++; }
    });
    const hasRequired = REQUIRED_FIELDS.every(function (f) { return f in mapping; });
    if (matches >= cfg.MIN_HEADER_MATCHES && hasRequired) {
      return { headerRowIndex: r, mapping: mapping, matches: matches };
    }
  }
  // Second pass: relax to "3 of 4 required" so a table missing only Status is
  // still recognised — its rows then fail validation individually and are
  // logged with a precise reason instead of the table vanishing silently.
  for (var r2 = 0; r2 < scanLimit; r2++) {
    const mapping2 = {};
    var matches2 = 0;
    rows[r2].forEach(function (cell, i) {
      const field = Masters.normalizeHeader(cell.text);
      if (field && !(field in mapping2)) { mapping2[field] = i; matches2++; }
    });
    var reqHit = REQUIRED_FIELDS.filter(function (f) { return f in mapping2; }).length;
    if (reqHit >= 3 && matches2 >= 3) {
      return { headerRowIndex: r2, mapping: mapping2, matches: matches2, partialHeader: true };
    }
  }
  return null;
}
