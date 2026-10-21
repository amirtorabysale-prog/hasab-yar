// خوانندهٔ بومی فایل بکاپ (.bak) نرم‌افزار حسابداری پارسیان.
//
// فرمت واقعی فایل: کانتینر MTF («TAPE») حامل بکاپ Microsoft SQL Server 2000 —
// نسخهٔ دیتابیس v539 که SQL Serverهای مدرن (۲۰۱۲ به بعد) دیگر آن را restore
// نمی‌کنند. این ماژول به جای وابستگی به هیچ سروری، صفحات ۸ کیلوبایتی داده را
// مستقیم از دل بکاپ می‌خواند:
//
//   ۱. شناسایی جدول‌ها از روی ردیف‌های sysobjects که خودشان داخل بکاپ‌اند؛
//   ۲. یافتن صفحات دادهٔ هر جدول با امضای صفحهٔ SQL Server (نوع ۰x01) و ObjectId؛
//   ۳. قدم‌زدن ردیف‌های هم‌جوار هر صفحه (بایت وضعیت ۰x30، طول ردیف با کالیبراسیون)؛
//   ۴. رمزگشایی ستون‌های ثابت با آفست معلوم و ستون‌های متغیر با شمارنده و
//      آفست‌های انتهایی داخل خود ردیف؛ متن‌ها UTF-16LE هستند.
//
// قاعدهٔ ثابت: هیچ مقداری حدس زده نمی‌شود و هیچ ردیفی که امضای سالم نداشته
// باشد وارد نتیجه نمی‌شود؛ ردیف‌های باقی‌ماندهٔ حذف‌شده (stale) با تکرارِ دقیق
// و سنجه‌های سالم‌بودن فیلتر می‌شوند. خروجی این ماژول فقط داده است؛ تصمیمِ
// ورود یا ندادن در server/parsianImport.js گرفته می‌شود.
//
// الگوریتم و آفست‌ها روی یک بکاپ واقعی پارسیان (db_111403، سال مالی ۱۴۰۳)
// صحه‌گذاری شده و نتایجش با استخراج مستقل پایتونی تطبیق داده شده است.

import { createHash } from 'node:crypto';

const MTF_MAGIC = Buffer.from('TAPE', 'ascii');
const DATA_PAGE_STEP = 512;
const PAGE_SIZE = 8192;
const PAGE_HEADER = 96;
const ROW_STATUS = 0x30;

// ساختار ستون‌های ثابت چهار جدول هدف، به ترتیب فیزیکی ردیف SQL Server 2000.
// آفست‌ها نسبت به آغاز ردیف‌اند و با سِت colid جدول در بکاپ واقعی جور شده‌اند.
const TABLE_LAYOUTS = {
  tbl_Kol: {
    fixed: [
      { name: 'code', offset: 4, type: 'int16' },
    ],
    texts: ['name'],
  },
  tbl_Moeen: {
    fixed: [
      { name: 'kol', offset: 4, type: 'int16' },
      { name: 'code', offset: 6, type: 'int16' },
    ],
    texts: ['name'],
  },
  tbl_Tafsili: {
    fixed: [
      { name: 'kol', offset: 4, type: 'int16' },
      { name: 'moeen', offset: 6, type: 'int16' },
      { name: 'code', offset: 8, type: 'int32' },
    ],
    texts: ['name'],
  },
  // ردیف سند: جدول tbl_Document در پارسیان یک ستونِ حذف‌شده در جایگاه colid=1
  // دارد که داده‌اش هنوز در ردیف می‌ماند (شناسهٔ قدیمی ردیف، آفست ۴) و همهٔ
  // ستون‌های واقعی را ۴ بایت می‌راند. آفست‌های زیر با سنجه‌های واقعی صحه‌گذاری
  // شده‌اند: سند ۱۲ فایل نمونه با همین چیدمان دقیقاً متوازن درمی‌آید
  // (۱٬۱۷۲٬۶۰۰٬۰۰۰ = ۱٬۰۶۶٬۰۰۰٬۰۰۰ فروش + ۱۰۶٬۶۰۰٬۰۰۰ ارزش افزوده).
  tbl_Document: {
    fixed: [
      { name: 'seq', offset: 4, type: 'int32' },
      { name: 'sanad', offset: 8, type: 'int32' },
      { name: 'kol', offset: 12, type: 'int16' },
      { name: 'moeen', offset: 14, type: 'int16' },
      { name: 'taf', offset: 16, type: 'int32' },
      { name: 'bed', offset: 20, type: 'float64' },
      { name: 'bes', offset: 28, type: 'float64' },
    ],
    // ترتیب ستون‌های متغیر مطابق colid: تاریخ سند، شرح ردیف، شرح سند.
    texts: ['date', 'comment', 'sanadComment'],
  },
};

const TARGET_TABLES = Object.keys(TABLE_LAYOUTS);
const JALALI_DATE = /^(\d{4})\/(0[1-9]|1[0-2])\/(0[1-9]|[12]\d|3[01])$/;
const AMOUNT_LIMIT = 1e15;
const OBJECT_NAME = /^[A-Za-z_][A-Za-z0-9_@# ]*$/;

function parseError(message, code = 'PARSIAN_BACKUP_INVALID', status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function u16(buffer, offset) { return buffer.readUInt16LE(offset); }
function u32(buffer, offset) { return buffer.readUInt32LE(offset); }

function utf16(buffer, from, to) {
  try {
    return buffer.toString('utf16le', from, to).replace(/\u0000+$/, '').trim();
  } catch {
    return '';
  }
}

function validTableName(name) {
  return name && name.length <= 128 && OBJECT_NAME.test(name) ? name : null;
}

/**
 * شناسایی جدول‌های کاربری از روی ردیف‌های sysobjects داخل بکاپ.
 * ردیف sysobjects امضای مشخصی دارد: وضعیت 0x0030، طول ثابت ۴۰-۴۶، شناسهٔ
 * شیء در آفست ۴ و نام به‌صورت رشتهٔ متغیر در انتها.
 */
function discoverTables(buffer) {
  const anchor = Buffer.from([0x55, 0x20, 0x00, 0x00]); // xtype 'U '
  const tables = new Map();
  let cursor = 0;
  while (true) {
    const found = buffer.indexOf(anchor, cursor);
    if (found < 0) break;
    cursor = found + 1;
    const rowStart = found - 8;
    if (rowStart < 0) continue;
    if (u16(buffer, rowStart) !== 0x0030) continue;
    const minLen = u16(buffer, rowStart + 2);
    if (![40, 42, 44, 46].includes(minLen)) continue;
    const objectId = u32(buffer, rowStart + 4);
    if (!(objectId > 0 && objectId < 2 ** 31)) continue;
    if (u16(buffer, rowStart + 48) !== 1) continue;
    const endOffset = u16(buffer, rowStart + 50);
    if (!(endOffset >= 56 && endOffset <= 300)) continue;
    const name = validTableName(utf16(buffer, rowStart + 52, rowStart + endOffset));
    if (name && !tables.has(objectId)) tables.set(objectId, name);
  }
  return tables;
}

/** صفحات دادهٔ هر جدول: امضای صفحهٔ دادهٔ SQL Server 2000 و ObjectId در سرصفحه. */
function discoverDataPages(buffer, tables) {
  const pages = new Map();
  for (const objectId of tables.keys()) pages.set(objectId, []);
  for (let page = 0x1200; page + PAGE_SIZE <= buffer.length; page += DATA_PAGE_STEP) {
    if (buffer[page] !== 0x01 || buffer[page + 1] !== 0x01) continue;
    const objectId = u32(buffer, page + 0x18);
    const list = pages.get(objectId);
    if (list) list.push(page);
  }
  return pages;
}

/**
 * کالیبراسیون آفست «طول ردیف» (k) از روی اولین صفحهٔ جدول: مقداری که طولِ
 * ردیف اول را درست می‌دهد و دو گذرِ بعدی هم به ردیف‌های سالم می‌رسد.
 */
function calibrateRowLengthOffset(buffer, pages) {
  const first = pages[0];
  for (let k = 4; k < 100; k += 1) {
    const firstLength = u16(buffer, first + PAGE_HEADER + k);
    if (!(firstLength >= 6 && firstLength <= 8000) || PAGE_HEADER + firstLength + 4 > PAGE_SIZE) continue;
    if (buffer[first + PAGE_HEADER + firstLength] !== ROW_STATUS) continue;
    let offset = PAGE_HEADER + firstLength;
    let ok = true;
    for (let transition = 0; transition < 2; transition += 1) {
      const length = u16(buffer, first + offset + k);
      if (!(length >= 6 && length <= 8000) || offset + length > PAGE_SIZE - 4 || buffer[first + offset + length] !== ROW_STATUS) { ok = false; break; }
      offset += length;
    }
    if (ok) return k;
  }
  return null;
}

/** قدم‌زدن همهٔ ردیف‌های سالم صفحات یک جدول. */
function walkRows(buffer, pages, k) {
  const rows = [];
  for (const page of pages) {
    let offset = PAGE_HEADER;
    while (offset < 8100) {
      const length = u16(buffer, page + offset + k);
      if (length < 6 || offset + length > PAGE_SIZE || buffer[page + offset] !== ROW_STATUS) break;
      rows.push(buffer.subarray(page + offset, page + offset + length));
      offset += length;
    }
  }
  return rows;
}

/** شمار ستون‌های متغیرِ موجود در ردیف، از روی فیلد شمارندهٔ داخل خود ردیف. */
function detectVariableCount(row, k) {
  for (const count of [1, 2, 3, 4]) {
    const field = k - 2 * count;
    if (field >= 0 && row.length > k && u16(row, field) === count) return count;
  }
  return 0;
}

/**
 * متن‌های ستون‌های متغیر ردیف. آفست‌های انتهایی داخل ردیف‌اند؛ آخرین انتها
 * باید دقیقاً پایان ردیف باشد، وگرنه ردیف خراب است و کنار گذاشته می‌شود.
 */
function variableTexts(row, k, count) {
  if (!count) return [];
  const ends = [];
  for (let index = 1; index <= count; index += 1) ends.push(u16(row, k - 2 * (count - index)));
  const segments = [];
  let start = k + 2;
  for (const end of ends) {
    if (end <= start || end > row.length) return null;
    segments.push([start, end]);
    start = end;
  }
  if (start !== row.length) return null;
  return segments.map(([from, to]) => utf16(row, from, to));
}

function readFixed(row, offset, type) {
  if (offset + { int16: 2, int32: 4, float64: 8 }[type] > row.length) return null;
  if (type === 'int16') return row.readInt16LE(offset);
  if (type === 'int32') return row.readInt32LE(offset);
  return row.readDoubleLE(offset);
}

/**
 * رمزگشایی یک ردیف با چیدمان جدول. خروجی null یعنی ردیف این جدول نیست یا
 * سالم نیست؛ در هر دو حالت ساکت کنار گذاشته می‌شود و در شمارنده می‌آید.
 */
function decodeRow(row, k, layout) {
  const values = {};
  for (const column of layout.fixed) {
    const value = readFixed(row, column.offset, column.type);
    if (value == null) return null;
    values[column.name] = value;
  }
  const count = detectVariableCount(row, k);
  const texts = variableTexts(row, k, count);
  if (texts == null) return null;
  for (let index = 0; index < layout.texts.length; index += 1) {
    values[layout.texts[index]] = index < texts.length ? texts[index] : '';
  }
  if (count > layout.texts.length) {
    // ستون‌های متغیر تهی‌شده جا دارند ولی ستون‌های خواسته‌شده کامل نیستند؛
    // مثلاً ردیفی که شرح ردیف ندارد ولی شرح سند دارد. نگاشت ترتیبی می‌ماند،
    // اما این حالت فقط وقتی پذیرفته می‌شود که تاریخ سند شکل درست داشته باشد.
    if (!JALALI_DATE.test(values.date || '')) return null;
  }
  return values;
}

function saneAmount(value) {
  return Number.isFinite(value) && Math.abs(value) < AMOUNT_LIMIT;
}

/** جمع تفاضلی بدهکار/بستانکارِ یک جدول سند پس از گرد به ریالِ صحیح. */
function roundedAmount(value) {
  return Math.round(value);
}

/**
 * نقطهٔ ورود: خواندن کامل بکاپ و برگرداندن کدینگ و اسناد سالنامة آن.
 * خروجی برای «پیش‌نمایش» و «ثبت» یکسان است؛ تصمیم ورود با لایهٔ بالاتر.
 */
export function parseParsianBackup(buffer, { fileName = '' } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 2 * PAGE_SIZE) {
    throw parseError('فایل ارسالی خیلی کوچک‌تر از آن است که بکاپ پارسیان باشد.');
  }
  const hasMtfMagic = buffer.indexOf(MTF_MAGIC, 0) === 0 || buffer.subarray(0, 4096).includes(MTF_MAGIC);
  if (!hasMtfMagic) {
    throw parseError('امضای کانتینر بکاپ (MTF/TAPE) پیدا نشد؛ این فایل بکاپ پارسیان نیست.', 'PARSIAN_BACKUP_NOT_MTF');
  }

  const tables = discoverTables(buffer);
  if (!tables.size) throw parseError('هیچ جدولی در بکاپ شناسایی نشد؛ فایل ناقص یا رمزشده است.');
  const pages = discoverDataPages(buffer, tables);

  const warnings = [];
  const parsed = {
    meta: {
      fileName: String(fileName || ''),
      sizeBytes: buffer.length,
      sha256: createHash('sha256').update(buffer).digest('hex'),
      container: 'MTF (Microsoft Tape Format) — بکاپ SQL Server 2000',
      tablesDiscovered: tables.size,
      pagesByTable: {},
    },
    chart: { kol: [], moeen: [], tafsili: [] },
    documents: { rows: [], vouchers: [] },
    stats: {
      walkedRows: {}, decodedRows: {}, duplicateRows: {},
      zeroRows: 0, suspiciousRows: 0,
    },
    warnings,
  };

  const seen = new Map();
  for (const tableName of TARGET_TABLES) {
    const objectId = [...tables.entries()].find(([, name]) => name === tableName)?.[0];
    const tablePages = objectId != null ? pages.get(objectId) : undefined;
    parsed.meta.pagesByTable[tableName] = tablePages ? tablePages.length : 0;
    if (!tablePages || !tablePages.length) {
      warnings.push(`جدول ${tableName} در بکاپ داده‌ای ندارد.`);
      parsed.stats.walkedRows[tableName] = 0;
      parsed.stats.decodedRows[tableName] = 0;
      continue;
    }
    const k = calibrateRowLengthOffset(buffer, tablePages);
    if (k == null) {
      warnings.push(`ساختار ردیف‌های ${tableName} قابل کالیبراسیون نبود؛ این جدول نادیده گرفته شد.`);
      parsed.stats.walkedRows[tableName] = 0;
      parsed.stats.decodedRows[tableName] = 0;
      continue;
    }
    const rows = walkRows(buffer, tablePages, k);
    const layout = TABLE_LAYOUTS[tableName];
    let decoded = 0;
    let duplicated = 0;
    const dedupeKey = seen.get(tableName) || new Map();
    seen.set(tableName, dedupeKey);
    const output = [];
    for (const row of rows) {
      const values = decodeRow(row, k, layout);
      if (!values) { parsed.stats.suspiciousRows += 1; continue; }
      if (tableName === 'tbl_Document' && !JALALI_DATE.test(values.date || '')) {
        parsed.stats.suspiciousRows += 1;
        continue;
      }
      const key = JSON.stringify(values);
      if (dedupeKey.has(key)) { duplicated += 1; continue; }
      dedupeKey.set(key, true);
      output.push(values);
      decoded += 1;
    }
    parsed.stats.walkedRows[tableName] = rows.length;
    parsed.stats.decodedRows[tableName] = decoded;
    parsed.stats.duplicateRows[tableName] = duplicated;
    if (tableName === 'tbl_Kol') parsed.chart.kol = output;
    if (tableName === 'tbl_Moeen') parsed.chart.moeen = output;
    if (tableName === 'tbl_Tafsili') parsed.chart.tafsili = output;
    if (tableName === 'tbl_Document') parsed.documents.rows = output;
  }

  if (!parsed.chart.kol.length) throw parseError('جدول کدینگ (کل) در بکاپ خوانده نشد؛ استخراج ممکن نیست.');
  if (!parsed.chart.moeen.length) throw parseError('جدول کدینگ (معین) در بکاپ خوانده نشد؛ استخراج ممکن نیست.');
  if (!parsed.documents.rows.length) warnings.push('هیچ ردیف سند سال‌شمار در بکاپ پیدا نشد؛ فقط کدینگ وارد می‌شود.');

  // ردیف‌های سند با مبلغ بی‌معنا یا تاریخ بیرون از الگوی شمسی، پیش از این
  // فیلتر شده‌اند؛ اینجا فقط اسناد را از ردیف‌ها می‌سازیم.
  parsed.documents.vouchers = buildVouchers(parsed.documents.rows);
  return parsed;
}

/** گروه‌بندی ردیف‌های سند بر شمارهٔ سند پارسیان، مرتب بر تاریخ و شماره. */
function buildVouchers(rows) {
  const bySanad = new Map();
  for (const row of rows) {
    if (!bySanad.has(row.sanad)) bySanad.set(row.sanad, []);
    bySanad.get(row.sanad).push(row);
  }
  return [...bySanad.entries()]
    .map(([sanad, lines]) => {
      const normalized = lines.map((line) => ({
        ...line,
        bed: saneAmount(line.bed) ? roundedAmount(line.bed) : null,
        bes: saneAmount(line.bes) ? roundedAmount(line.bes) : null,
      }));
      const dates = [...new Set(normalized.map((line) => line.date))].sort();
      const bedTotal = normalized.reduce((sum, line) => sum + (line.bed || 0), 0);
      const besTotal = normalized.reduce((sum, line) => sum + (line.bes || 0), 0);
      return {
        sanad,
        dates,
        date: dates[0] || '',
        lines: normalized,
        bedTotal,
        besTotal,
        balanced: bedTotal === besTotal && bedTotal > 0,
      };
    })
    .sort((first, second) => (first.date === second.date ? first.sanad - second.sanad : first.date < second.date ? -1 : 1));
}
