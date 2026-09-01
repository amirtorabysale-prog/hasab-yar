// خواندن و نوشتن فایل اکسل (xlsx) بدون هیچ وابستگی تازه.
//
// حسابدار در اکسل زندگی می‌کند و نرم‌افزارهای حسابداری ایرانی هم ورودی/خروجی
// اکسل دارند. افزودن یک کتابخانهٔ خارجی برای این کار، سطح حمله و وابستگی
// پروژه را بی‌دلیل بزرگ می‌کرد؛ xlsx در عمل یک ZIP از چند XML ساده است و
// Node هم zlib داخلی دارد.
//
// این ماژول عمداً محدود است: فقط سلول متن و عدد. فرمول، استایل، تاریخ سریالی
// اکسل و چند شیت پیچیده پشتیبانی نمی‌شوند و ساکت حدس زده نمی‌شوند.

import { deflateRawSync, inflateRawSync } from 'node:zlib';

export const SPREADSHEET_LIMITS = Object.freeze({
  maxCompressedBytes: 2 * 1024 * 1024,
  maxEntries: 128,
  maxEntryBytes: 8 * 1024 * 1024,
  maxUncompressedBytes: 16 * 1024 * 1024,
  maxCompressionRatio: 100,
  maxSheets: 20,
  maxRows: 50_000,
  maxColumns: 256,
  maxCells: 500_000,
});

function spreadsheetError(message, code = 'SPREADSHEET_INVALID', status = 400) {
  return Object.assign(new Error(message), { code, status });
}

// ---------------------------------------------------------------------------
// CRC32 و ZIP
// ---------------------------------------------------------------------------

const crcTable = (() => {
  const table = new Int32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? (value >>> 1) ^ 0xEDB88320 : value >>> 1;
    table[index] = value;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let index = 0; index < buffer.length; index += 1) crc = (crc >>> 8) ^ crcTable[(crc ^ buffer[index]) & 0xFF];
  return (crc ^ -1) >>> 0;
}

// زمان ثابت DOS برای اینکه یک محتوای یکسان همیشه بایت‌های یکسان بدهد؛ digest
// خروجی نباید با گذر ساعت عوض شود.
const DOS_TIME = 0;
const DOS_DATE = ((2020 - 1980) << 9) | (1 << 5) | 1;

function zipEntry(name, content) {
  const nameBuffer = Buffer.from(name, 'utf8');
  const raw = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  const compressed = deflateRawSync(raw, { level: 9 });
  // اگر فشرده‌سازی سود نداشت، همان بایت خام ذخیره می‌شود.
  const useDeflate = compressed.length < raw.length;
  return {
    nameBuffer,
    method: useDeflate ? 8 : 0,
    crc: crc32(raw),
    data: useDeflate ? compressed : raw,
    rawSize: raw.length,
  };
}

function buildZip(files) {
  const entries = files.map(({ name, content }) => zipEntry(name, content));
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // نام فایل UTF-8 است
    local.writeUInt16LE(entry.method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(entry.crc, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.rawSize, 22);
    local.writeUInt16LE(entry.nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, entry.nameBuffer, entry.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(entry.method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(entry.crc, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.rawSize, 24);
    central.writeUInt16LE(entry.nameBuffer.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, entry.nameBuffer);

    offset += 30 + entry.nameBuffer.length + entry.data.length;
  }

  const centralBuffer = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralBuffer, end]);
}

function readZip(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) throw spreadsheetError('فایل اکسل خوانده نشد؛ محتوا خالی یا ناقص است.', 'SPREADSHEET_EMPTY');
  if (buffer.length > SPREADSHEET_LIMITS.maxCompressedBytes) {
    throw spreadsheetError('حجم فایل اکسل بیش از سقف ۲ مگابایت است.', 'SPREADSHEET_COMPRESSED_TOO_LARGE', 413);
  }
  let endOffset = -1;
  for (let index = buffer.length - 22; index >= 0 && index >= buffer.length - 66_000; index -= 1) {
    if (buffer.readUInt32LE(index) === 0x06054b50) { endOffset = index; break; }
  }
  if (endOffset < 0) throw spreadsheetError('این فایل یک فایل اکسل (xlsx) معتبر نیست.', 'SPREADSHEET_NOT_XLSX');

  const count = buffer.readUInt16LE(endOffset + 10);
  if (count > SPREADSHEET_LIMITS.maxEntries) {
    throw spreadsheetError(`تعداد فایل‌های داخلی اکسل بیش از سقف ${SPREADSHEET_LIMITS.maxEntries} است.`, 'SPREADSHEET_TOO_MANY_ENTRIES', 413);
  }
  let pointer = buffer.readUInt32LE(endOffset + 16);
  const files = new Map();
  let totalUncompressed = 0;
  for (let index = 0; index < count; index += 1) {
    if (pointer < 0 || pointer + 46 > endOffset) throw spreadsheetError('ساختار داخلی فایل اکسل ناقص است.', 'SPREADSHEET_CORRUPT');
    if (buffer.readUInt32LE(pointer) !== 0x02014b50) throw spreadsheetError('ساختار داخلی فایل اکسل خراب است.', 'SPREADSHEET_CORRUPT');
    const method = buffer.readUInt16LE(pointer + 10);
    const compressedSize = buffer.readUInt32LE(pointer + 20);
    const uncompressedSize = buffer.readUInt32LE(pointer + 24);
    const nameLength = buffer.readUInt16LE(pointer + 28);
    const extraLength = buffer.readUInt16LE(pointer + 30);
    const commentLength = buffer.readUInt16LE(pointer + 32);
    const localOffset = buffer.readUInt32LE(pointer + 42);
    if (pointer + 46 + nameLength + extraLength + commentLength > endOffset) throw spreadsheetError('فهرست داخلی فایل اکسل ناقص است.', 'SPREADSHEET_CORRUPT');
    const name = buffer.toString('utf8', pointer + 46, pointer + 46 + nameLength);
    if (!name || files.has(name)) throw spreadsheetError('نام بخش‌های داخلی فایل اکسل خالی یا تکراری است.', 'SPREADSHEET_CORRUPT');

    if (uncompressedSize > SPREADSHEET_LIMITS.maxEntryBytes) {
      throw spreadsheetError(`بخش «${name}» پس از بازشدن بیش از سقف مجاز است.`, 'SPREADSHEET_ENTRY_TOO_LARGE', 413);
    }
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > SPREADSHEET_LIMITS.maxUncompressedBytes) {
      throw spreadsheetError('حجم بازشدهٔ فایل اکسل بیش از سقف ۱۶ مگابایت است.', 'SPREADSHEET_UNCOMPRESSED_TOO_LARGE', 413);
    }
    if (uncompressedSize > 0 && (compressedSize === 0 || uncompressedSize / compressedSize > SPREADSHEET_LIMITS.maxCompressionRatio)) {
      throw spreadsheetError(`نسبت فشرده‌سازی بخش «${name}» مشکوک است.`, 'SPREADSHEET_COMPRESSION_RATIO', 413);
    }

    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) throw spreadsheetError('آدرس بخش داخلی اکسل معتبر نیست.', 'SPREADSHEET_CORRUPT');
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    if (dataStart + compressedSize > buffer.length) throw spreadsheetError('دادهٔ داخلی فایل اکسل ناقص است.', 'SPREADSHEET_CORRUPT');
    const slice = buffer.subarray(dataStart, dataStart + compressedSize);
    if (method !== 0 && method !== 8) throw spreadsheetError('روش فشرده‌سازی این فایل اکسل پشتیبانی نمی‌شود.', 'SPREADSHEET_COMPRESSION');
    let content;
    try {
      content = method === 8 ? inflateRawSync(slice, { maxOutputLength: SPREADSHEET_LIMITS.maxEntryBytes }) : Buffer.from(slice);
    } catch (error) {
      if (error?.code === 'ERR_BUFFER_TOO_LARGE' || /larger than/i.test(error?.message || '')) {
        throw spreadsheetError(`بخش «${name}» هنگام بازشدن از سقف مجاز عبور کرد.`, 'SPREADSHEET_ENTRY_TOO_LARGE', 413);
      }
      throw spreadsheetError(`بخش «${name}» قابل بازشدن نیست.`, 'SPREADSHEET_CORRUPT');
    }
    if (content.length !== uncompressedSize) throw spreadsheetError(`اندازهٔ بخش «${name}» با فهرست فایل سازگار نیست.`, 'SPREADSHEET_CORRUPT');
    files.set(name, content);

    pointer += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

// ---------------------------------------------------------------------------
// XML
// ---------------------------------------------------------------------------

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
    // نویسه‌های کنترلی در XML 1.0 مجاز نیستند و Excel فایل را خراب اعلام می‌کند.
    .replace(new RegExp("[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F]", "g"), '');
}

function unescapeXml(value) {
  return String(value ?? '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, '&');
}

export function columnName(index) {
  let name = '';
  let value = index + 1;
  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - remainder) / 26);
  }
  return name;
}

export function columnIndex(reference) {
  const letters = String(reference || '').match(/^[A-Z]+/i)?.[0] || '';
  let index = 0;
  for (const letter of letters.toUpperCase()) index = index * 26 + (letter.charCodeAt(0) - 64);
  return index - 1;
}

// ---------------------------------------------------------------------------
// نوشتن
// ---------------------------------------------------------------------------

function cellXml(value, reference) {
  if (value == null || value === '') return '';
  if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${reference}"><v>${value}</v></c>`;
  const text = String(value);
  // متنی که فقط رقم است هم عمداً به‌شکل متن نوشته می‌شود مگر خودش عدد باشد؛
  // کد حساب «۰۱۲» نباید صفر ابتدایش را از دست بدهد.
  return `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(text)}</t></is></c>`;
}

function sheetXml(rows) {
  const body = rows.map((row, rowIndex) => {
    const cells = (row || []).map((value, cellIndex) => cellXml(value, `${columnName(cellIndex)}${rowIndex + 1}`)).join('');
    return `<row r="${rowIndex + 1}">${cells}</row>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
}

/**
 * یک کتاب کار تک‌شیتی یا چندشیتی می‌سازد.
 * sheets: [{ name, rows: [[cell, ...], ...] }]
 */
export function buildWorkbook(sheets = []) {
  const list = (Array.isArray(sheets) ? sheets : []).filter((item) => item && Array.isArray(item.rows));
  if (!list.length) throw spreadsheetError('کتاب کار بدون شیت ساخته نمی‌شود.', 'SPREADSHEET_NO_SHEET');
  // نام شیت در اکسل حداکثر ۳۱ نویسه و بدون این نویسه‌هاست.
  const names = list.map((item, index) => String(item.name || `Sheet${index + 1}`).replace(/[\\/*?:[\]]/g, ' ').slice(0, 31) || `Sheet${index + 1}`);

  const sheetEntries = list.map((item, index) => ({ name: `xl/worksheets/sheet${index + 1}.xml`, content: sheetXml(item.rows) }));
  const workbookSheets = names.map((name, index) => `<sheet name="${escapeXml(name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('');
  const workbookRels = names.map((_name, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join('');
  const overrides = names.map((_name, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('');

  return buildZip([
    {
      name: '[Content_Types].xml',
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${overrides}</Types>`,
    },
    {
      name: '_rels/.rels',
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    },
    {
      name: 'xl/workbook.xml',
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${workbookSheets}</sheets></workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${workbookRels}</Relationships>`,
    },
    ...sheetEntries,
  ]);
}

// ---------------------------------------------------------------------------
// خواندن
// ---------------------------------------------------------------------------

function parseSharedStrings(xml) {
  if (!xml) return [];
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((match) => (
    // یک si می‌تواند چند بخش <t> داشته باشد (متن با قالب‌بندی جزئی).
    [...match[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((part) => unescapeXml(part[1])).join('')
  ));
}

function parseSheet(xml, sharedStrings, budget) {
  const rows = [];
  for (const rowMatch of xml.matchAll(/<row[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
    const rowNumber = Number(rowMatch[1]);
    if (!Number.isSafeInteger(rowNumber) || rowNumber < 1 || rowNumber > SPREADSHEET_LIMITS.maxRows) {
      throw spreadsheetError(`شمارهٔ ردیف اکسل بیش از سقف ${SPREADSHEET_LIMITS.maxRows} است.`, 'SPREADSHEET_TOO_MANY_ROWS', 413);
    }
    const cells = [];
    for (const cellMatch of rowMatch[2].matchAll(/<c([^>]*)\/>|<c([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attributes = cellMatch[1] ?? cellMatch[2] ?? '';
      const body = cellMatch[3] ?? '';
      const reference = attributes.match(/r="([A-Z]+\d+)"/)?.[1];
      const type = attributes.match(/t="([^"]+)"/)?.[1] || 'n';
      let value = '';
      if (type === 'inlineStr') value = [...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((part) => unescapeXml(part[1])).join('');
      else if (type === 's') value = sharedStrings[Number(unescapeXml(body.match(/<v>([\s\S]*?)<\/v>/)?.[1] || '-1'))] ?? '';
      else if (type === 'str' || type === 'e') value = unescapeXml(body.match(/<v>([\s\S]*?)<\/v>/)?.[1] || '');
      else value = unescapeXml(body.match(/<v>([\s\S]*?)<\/v>/)?.[1] || '');
      const target = reference ? columnIndex(reference) : cells.length;
      if (target < 0 || target >= SPREADSHEET_LIMITS.maxColumns) {
        throw spreadsheetError(`تعداد ستون‌های اکسل بیش از سقف ${SPREADSHEET_LIMITS.maxColumns} است.`, 'SPREADSHEET_TOO_MANY_COLUMNS', 413);
      }
      budget.cells += 1;
      if (budget.cells > SPREADSHEET_LIMITS.maxCells) {
        throw spreadsheetError(`تعداد سلول‌های اکسل بیش از سقف ${SPREADSHEET_LIMITS.maxCells} است.`, 'SPREADSHEET_TOO_MANY_CELLS', 413);
      }
      while (cells.length < target) cells.push('');
      cells[target] = value;
    }
    while (rows.length < rowNumber - 1) rows.push([]);
    rows[rowNumber - 1] = cells;
  }
  return rows;
}

/**
 * یک xlsx را به شیت‌های ساده تبدیل می‌کند: [{ name, rows: [[متن, ...]] }].
 * همهٔ سلول‌ها متن برمی‌گردند؛ تبدیل به عدد وظیفهٔ لایهٔ بالاتر است تا قاعدهٔ
 * پارس مبلغ فارسی در یک جا بماند.
 */
export function readWorkbook(buffer) {
  const files = readZip(buffer);
  const workbook = files.get('xl/workbook.xml')?.toString('utf8');
  if (!workbook) throw spreadsheetError('این فایل شیت اکسل ندارد.', 'SPREADSHEET_NOT_XLSX');
  const sharedStrings = parseSharedStrings(files.get('xl/sharedStrings.xml')?.toString('utf8'));

  const relationships = new Map([...(files.get('xl/_rels/workbook.xml.rels')?.toString('utf8') || '')
    .matchAll(/<Relationship\s[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)]
    .map((match) => [match[1], match[2].replace(/^\/?xl\//, '').replace(/^\//, '')]));

  const sheets = [];
  const budget = { cells: 0 };
  let fallbackIndex = 0;
  for (const match of workbook.matchAll(/<sheet\s[^>]*?name="([^"]*)"[^>]*?(?:r:id="([^"]+)")?[^>]*\/>/g)) {
    fallbackIndex += 1;
    if (fallbackIndex > SPREADSHEET_LIMITS.maxSheets) {
      throw spreadsheetError(`تعداد شیت‌های اکسل بیش از سقف ${SPREADSHEET_LIMITS.maxSheets} است.`, 'SPREADSHEET_TOO_MANY_SHEETS', 413);
    }
    const target = (match[2] && relationships.get(match[2])) || `worksheets/sheet${fallbackIndex}.xml`;
    const xml = files.get(`xl/${target}`)?.toString('utf8');
    if (!xml) continue;
    sheets.push({ name: unescapeXml(match[1]), rows: parseSheet(xml, sharedStrings, budget) });
  }
  if (!sheets.length) throw spreadsheetError('هیچ شیت قابل خواندنی در فایل پیدا نشد.', 'SPREADSHEET_NO_SHEET');
  return sheets;
}

export function isXlsxBuffer(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length > 4 && buffer.readUInt32LE(0) === 0x04034b50;
}

// ---------------------------------------------------------------------------
// CSV به‌عنوان ورودی جایگزین
// ---------------------------------------------------------------------------

function splitCsvLine(line, separator) {
  const cells = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"' && quoted && line[index + 1] === '"') { value += '"'; index += 1; }
    else if (char === '"') quoted = !quoted;
    else if (char === separator && !quoted) { cells.push(value.trim()); value = ''; }
    else value += char;
  }
  cells.push(value.trim());
  return cells;
}

export function readDelimitedText(input, sheetName = 'Sheet1') {
  const text = String(input ?? '').replace(/^﻿/, '');
  if (Buffer.byteLength(text, 'utf8') > SPREADSHEET_LIMITS.maxCompressedBytes) {
    throw spreadsheetError('حجم فایل متنی بیش از سقف ۲ مگابایت است.', 'SPREADSHEET_COMPRESSED_TOO_LARGE', 413);
  }
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length);
  if (!lines.length) throw spreadsheetError('فایل خالی است.', 'SPREADSHEET_EMPTY');
  if (lines.length > SPREADSHEET_LIMITS.maxRows) {
    throw spreadsheetError(`تعداد ردیف‌ها بیش از سقف ${SPREADSHEET_LIMITS.maxRows} است.`, 'SPREADSHEET_TOO_MANY_ROWS', 413);
  }
  const separator = [',', ';', '\t'].reduce((best, candidate) => (
    splitCsvLine(lines[0], candidate).length > splitCsvLine(lines[0], best).length ? candidate : best
  ), ',');
  const rows = lines.map((line) => splitCsvLine(line, separator));
  if (rows.some((row) => row.length > SPREADSHEET_LIMITS.maxColumns)) {
    throw spreadsheetError(`تعداد ستون‌ها بیش از سقف ${SPREADSHEET_LIMITS.maxColumns} است.`, 'SPREADSHEET_TOO_MANY_COLUMNS', 413);
  }
  if (rows.reduce((total, row) => total + row.length, 0) > SPREADSHEET_LIMITS.maxCells) {
    throw spreadsheetError(`تعداد سلول‌ها بیش از سقف ${SPREADSHEET_LIMITS.maxCells} است.`, 'SPREADSHEET_TOO_MANY_CELLS', 413);
  }
  return [{ name: sheetName, rows }];
}

/**
 * ورودی کاربر می‌تواند xlsx یا CSV باشد؛ تشخیص از روی بایت‌های فایل است، نه پسوند.
 */
export function readTabularFile(buffer, fileName = '') {
  if (isXlsxBuffer(buffer)) return readWorkbook(buffer);
  const text = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer ?? '');
  if (/^PK/.test(text)) throw spreadsheetError('این فایل فشرده است اما xlsx معتبر نیست.', 'SPREADSHEET_NOT_XLSX');
  return readDelimitedText(text, fileName || 'Sheet1');
}
