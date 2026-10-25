"use strict";

// Minimal RFC 4180 CSV parser (quoted fields, escaped quotes, CRLF) with
// formula-injection neutralisation for any value that may be exported later.

function parseCsv(text, { maxRows = 5000, maxColumns = 50 } = {}) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  const input = String(text).replace(/^﻿/, "");
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (quoted) {
      if (char === '"') {
        if (input[index + 1] === '"') {
          field += '"';
          index += 1;
        } else quoted = false;
      } else field += char;
      continue;
    }
    if (char === '"' && field === "") quoted = true;
    else if (char === ",") {
      row.push(field);
      field = "";
      if (row.length > maxColumns) throw new Error("CSV_TOO_MANY_COLUMNS");
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && input[index + 1] === "\n") index += 1;
      row.push(field);
      field = "";
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
      if (rows.length > maxRows + 1) throw new Error("CSV_TOO_MANY_ROWS");
    } else field += char;
  }
  if (quoted) throw new Error("CSV_UNTERMINATED_QUOTE");
  row.push(field);
  if (row.some((value) => value !== "")) rows.push(row);
  if (rows.length > maxRows + 1) throw new Error("CSV_TOO_MANY_ROWS");
  return rows;
}

const FORMULA_PREFIX = /^[=+\-@\t\r]/;

function neutralizeCell(value) {
  const text = String(value ?? "").trim();
  return FORMULA_PREFIX.test(text) ? `'${text}` : text;
}

function isFormula(value) {
  return FORMULA_PREFIX.test(String(value ?? "").trim());
}

module.exports = { parseCsv, neutralizeCell, isFormula };
