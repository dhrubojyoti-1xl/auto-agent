/**
 * Minimal in-memory Apps Script emulator, used ONLY to run the .gs files
 * under Node so the parser/metrics/report code can be tested without Google.
 * Not part of the deployed system.
 */
const crypto = require('crypto');

function pad(n, w) { return String(n).padStart(w || 2, '0'); }
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

const Utilities = {
  Charset: { UTF_8: 'utf8' },
  DigestAlgorithm: { SHA_1: 'sha1' },
  sleep() {},
  computeDigest(alg, s) {
    const buf = crypto.createHash('sha1').update(String(s), 'utf8').digest();
    return Array.from(buf).map(b => (b > 127 ? b - 256 : b));
  },
  formatDate(date, tz, fmt) {
    const d = new Date(date);
    return fmt
      .replace(/yyyy/g, d.getFullYear())
      .replace(/MMM/g, MON[d.getMonth()])
      .replace(/MM/g, pad(d.getMonth() + 1))
      .replace(/dd/g, pad(d.getDate()))
      .replace(/HH/g, pad(d.getHours()))
      .replace(/mm/g, pad(d.getMinutes()))
      .replace(/ss/g, pad(d.getSeconds()));
  }
};

class Range {
  constructor(sheet, r, c, nr, nc) { this.sheet = sheet; this.r = r; this.c = c; this.nr = nr; this.nc = nc; }
  getValues() {
    const out = [];
    for (let i = 0; i < this.nr; i++) {
      const row = [];
      for (let j = 0; j < this.nc; j++) {
        const rr = this.sheet.data[this.r - 1 + i];
        row.push(rr ? (rr[this.c - 1 + j] === undefined ? '' : rr[this.c - 1 + j]) : '');
      }
      out.push(row);
    }
    return out;
  }
  setValues(vals) {
    for (let i = 0; i < vals.length; i++) {
      const ri = this.r - 1 + i;
      while (this.sheet.data.length <= ri) this.sheet.data.push([]);
      for (let j = 0; j < vals[i].length; j++) this.sheet.data[ri][this.c - 1 + j] = vals[i][j];
    }
    this.sheet.maxRows = Math.max(this.sheet.maxRows, this.r - 1 + vals.length);
    return this;
  }
  setValue(v) { return this.setValues([[v]]); }
  clearContent() {
    for (let i = 0; i < this.nr; i++) {
      const rr = this.sheet.data[this.r - 1 + i];
      if (!rr) continue;
      for (let j = 0; j < this.nc; j++) rr[this.c - 1 + j] = '';
    }
    return this;
  }
  setNumberFormat() { return this; }
  setFontWeight() { return this; }
  setBackground() { return this; }
  setDataValidation() { return this; }
}

class Sheet {
  constructor(name) { this.name = name; this.data = []; this.maxRows = 1000; this.maxCols = 40; }
  getName() { return this.name; }
  getRange(r, c, nr, nc) { return new Range(this, r, c, nr === undefined ? 1 : nr, nc === undefined ? 1 : nc); }
  getLastRow() {
    let last = 0;
    this.data.forEach((row, i) => {
      if (row && row.some(v => v !== '' && v !== undefined && v !== null)) last = i + 1;
    });
    return last;
  }
  getLastColumn() {
    let last = 0;
    this.data.forEach(row => { if (row) last = Math.max(last, row.length); });
    return last;
  }
  getMaxRows() { return Math.max(this.maxRows, this.data.length); }
  getMaxColumns() { return this.maxCols; }
  insertRowsAfter(after, n) { this.maxRows += n; return this; }
  insertColumnsAfter(after, n) { this.maxCols += n; return this; }
  deleteColumns(start, n) { this.maxCols = Math.max(1, this.maxCols - n); return this; }
  deleteRows(start, n) { this.data.splice(start - 1, n); return this; }
  setFrozenRows() { return this; }
  autoResizeColumns() { return this; }
}

class Spreadsheet {
  constructor() { this.sheets = []; }
  getId() { return 'LOCAL-TEST-SPREADSHEET'; }
  getSheets() { return this.sheets; }
  getSheetByName(n) { return this.sheets.find(s => s.name === n) || null; }
  insertSheet(n) { const s = new Sheet(n); this.sheets.push(s); return s; }
  deleteSheet(s) { this.sheets = this.sheets.filter(x => x !== s); }
}

const SS = new Spreadsheet();
const SpreadsheetApp = {
  getActiveSpreadsheet: () => SS,
  openById: () => SS,
  getUi() { throw new Error('no ui'); },
  newDataValidation: () => ({
    requireValueInList() { return this; },
    setAllowInvalid() { return this; },
    build() { return {}; }
  })
};

const props = {};
const PropertiesService = {
  getScriptProperties: () => ({
    getProperty: k => (k in props ? props[k] : null),
    setProperty: (k, v) => { props[k] = v; },
    deleteProperty: k => { delete props[k]; }
  })
};

const GmailApp = {
  search: () => [],
  getUserLabelByName: () => ({ getName: () => 'stub' }),
  createLabel: n => ({ getName: () => n })
};
const MailApp = { sendEmail: () => {} };
const UrlFetchApp = { fetch: () => { throw new Error('network disabled in test harness'); } };
const LockService = { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) };
const ScriptApp = {
  WeekDay: { MONDAY: 'MONDAY' },
  getProjectTriggers: () => [],
  newTrigger: () => ({ timeBased: () => ({ everyMinutes(){return this;}, everyHours(){return this;},
    atHour(){return this;}, nearMinute(){return this;}, everyDays(){return this;},
    onWeekDay(){return this;}, create(){} }) })
};
const Session = { getScriptTimeZone: () => 'Asia/Kolkata' };

module.exports = { Utilities, SpreadsheetApp, PropertiesService, GmailApp, MailApp,
  UrlFetchApp, LockService, ScriptApp, Session, SS };
