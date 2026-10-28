// خوانندهٔ بومی فایل بکاپ (.bak) نرم‌افزار حسابداری پارسیان.
//
// فرمت واقعی فایل: کانتینر MTF («TAPE») حامل بکاپ Microsoft SQL Server 2000.
// SQL Serverهای امروزی این نسخه را restore نمی‌کنند، پس صفحه‌های ۸ کیلوبایتی
// دیتابیس مستقیم از دل بکاپ خوانده می‌شوند. چهار قاعده که بدون هرکدام عدد غلط
// درمی‌آید (همه روی بکاپ واقعی سال ۱۴۰۳ اثبات شده‌اند):
//
//   ۱. بکاپ فقط extentهای تخصیص‌یافته را دارد و پشت هم نمی‌چیند؛ جای هر صفحه
//      از شمارهٔ صفحهٔ داخل سرصفحه‌اش معلوم می‌شود، نه از فاصله‌اش تا آغاز فایل.
//   ۲. torn page detection: دو بیت پایینِ آخرین بایت هر بخش ۵۱۲تایی با الگوی
//      کنترلی جایگزین شده و بیت‌های اصلی در m_tornBits سرصفحه مانده‌اند. بدون
//      برگرداندنشان کد حساب، شمارهٔ سند، مبلغ و متن خراب خوانده می‌شود.
//   ۳. صفحه‌ای که در PFS «تخصیص‌نیافته» است داده‌ی کهنه دارد (پس از جابه‌جایی
//      ردیف‌ها خالی شده ولی extentش هنوز در بکاپ آمده)؛ خوانده نمی‌شود.
//   ۴. ردیف زنده فقط ردیفی است که آرایهٔ slot انتهای صفحه به آن اشاره می‌کند؛
//      بایت‌های ردیف حذف‌شده تا فشرده‌سازی صفحه همان‌جا می‌مانند.
//
// چیدمان ستون‌ها حدس زده نمی‌شود: از sysobjects و syscolumns خود بکاپ خوانده
// می‌شود. خروجی این ماژول فقط داده است؛ تصمیم ورود در server/parsianImport.js.

import { createHash } from 'node:crypto';

const PAGE_SIZE = 8192;
const SECTOR = 512;
const PAGE_HEADER = 96;
const PFS_INTERVAL = 8088;
const PAGE_TYPES = new Set([1, 2, 3, 8, 9, 10, 11, 13, 16, 17]);
const DATA_PAGE = 1;
const SYSOBJECTS = 1;
const SYSCOLUMNS = 3;
const JALALI_DATE = /^(\d{4})\/(0[1-9]|1[0-2])\/(0[1-9]|[12]\d|3[01])$/;

// ستون‌هایی که از هر جدول پارسیان لازم است. نام ستون از syscolumns پیدا می‌شود؛
// ستون اجباری که در بکاپ نباشد یعنی این فایل از نسخه‌ای است که نمی‌شناسیم.
const TABLES = {
  tbl_Kol: { required: ['Code', 'CName'], optional: ['GroupCode', 'iType'] },
  tbl_Moeen: { required: ['KolCode', 'Code', 'CName'], optional: [] },
  tbl_Tafsili: { required: ['KolCode', 'MoeenCode', 'Code', 'CName'], optional: [] },
  tbl_ACCGroup: { required: ['Code', 'CName'], optional: [], missingTableAllowed: true },
  tbl_Document: {
    required: ['ID', 'Sanad_Num', 'SanadDate', 'KolCode', 'MoeenCode', 'TafsiliCode', 'Bed', 'Bes'],
    optional: ['Comment', 'SanadComment', 'Factor_Num'],
  },
};

// اطلاعات پایهٔ بیرون از اسناد: کالا، کارت طرف حساب (تلفن، نشانی، کد اقتصادی)،
// فاکتورها و مشخصات شرکت. هیچ‌کدام اجباری نیست؛ نبودن یا ناخوانا بودنشان فقط
// هشدار است و ورود اسناد را نمی‌بندد. فقط همین ستون‌ها خوانده می‌شوند.
//
// جدول‌هایی که راز دارند هرگز خوانده نمی‌شوند: tbl_NEWMovadianInfo (کلید خصوصی و
// توکن سامانهٔ مؤدیان)، tbl_User (رمز کاربران)، tbl_LC و tbl_Company (قفل و مجوز).
const EXTRA_TABLES = {
  // چک: نوع (۰ دریافتی، ۱ پرداختی)، وضعیت (Vos_Pas)، صاحب (Acc)، حساب اسناد (Taraf)،
  // گیرندهٔ واگذاری (Bank) و سند ثبت و تسویه. معنای کدها در server/parsianCheques.js.
  tbl_Check: {
    required: ['ID', 'Money', 'Chk_Kind', 'Vos_Pas'],
    optional: ['Chk_Num', 'Sanad_Num', 'Sanad_Num_VosolPas', 'ExpDate', 'RecDate', 'Giv_Date', 'Bank_K', 'Bank_M', 'Bank_T',
      'Acc_K', 'Acc_M', 'Acc_T', 'Taraf_K', 'Taraf_M', 'Taraf_T', 'Comment', 'Bank', 'IsActive', 'Sayad'],
    missingTableAllowed: true,
  },
  // تاریخچهٔ چک: پارسیان پیش از هر تغییر وضعیت، ردیف قبلیِ چک را این‌جا نگه می‌دارد
  // (در بکاپ اتیه سازان یک ردیف «در جریان» برای هر چکِ تسویه‌شده).
  tbl_RecycleCheck: {
    required: ['CHK_ID', 'Vos_Pas'],
    optional: ['ID', 'ExpDate', 'Giv_Date', 'Acc_K', 'Acc_M', 'Acc_T', 'Bank_K', 'Bank_M', 'Bank_T', 'Sanad_Num', 'IsActive'],
    missingTableAllowed: true,
  },
  tbl_Goods: { required: ['Code', 'CName'], optional: ['GroupCode', 'UnitName_1', 'Price_1', 'VATPercent', 'Barcode'], missingTableAllowed: true },
  tbl_GoodsGroup: { required: ['Code', 'CName'], optional: ['IsService'], missingTableAllowed: true },
  tbl_Telephone: {
    required: ['CName'], optional: ['KolCode', 'MoeenCode', 'TafsiliCode', 'Tel', 'Mobile', 'Address', 'CodeEco', 'CodeNat', 'CodePost'],
    missingTableAllowed: true,
  },
  tbl_FactorKind: { required: ['Code', 'CName'], optional: [], missingTableAllowed: true },
  tbl_Factor: {
    required: ['ID', 'Factor_Num', 'Factor_Date', 'TitleCode'],
    optional: ['Sanad_Num', 'GoodsCode', 'Tedad', 'Price', 'Discont', 'GoodsComment', 'FactorComment', 'SarResid_Date'],
    missingTableAllowed: true,
  },
  tbl_CoSpec: { required: [], optional: ['ECOcode', 'PostalCode', 'Code', 'Address', 'Tel', 'Estate', 'City'], missingTableAllowed: true },
};

// حساب‌هایی که خود پارسیان در تنظیماتش برای هر کار تعیین کرده (صندوق، فروش،
// بهای تمام‌شده، ارزش افزوده و ...). هر کدام سه ستون کل/معین/تفصیلی دارد.
// فقط خوانده می‌شوند؛ اینکه به کدام نقش حساب‌یار می‌خورند در لایهٔ ورود است.
const DESIGNATED = {
  tbl_AccSetting: ['Cash', 'Sell', 'BahayeTam', 'Wage', 'Loan', 'Asset', 'RecDoc', 'DlDoc', 'MojodyMavad'],
  tbl_VATSetting: ['VATSale', 'VATBuy'],
};
for (const [table, keys] of Object.entries(DESIGNATED)) {
  TABLES[table] = { required: [], optional: keys.flatMap((key) => [`${key}_K`, `${key}_M`, `${key}_T`]), missingTableAllowed: true };
}

function parseError(message, code = 'PARSIAN_BACKUP_INVALID', status = 400) {
  return Object.assign(new Error(message), { code, status });
}

/** برگرداندن بیت‌هایی که torn page detection در انتهای هر بخش ۵۱۲تایی گذاشته است. */
export function restoreTornBits(page) {
  if (!(page.readUInt16LE(4) & 0x100)) return 0;
  const torn = page.readUInt32LE(60);
  let changed = 0;
  for (let sector = 1; sector < PAGE_SIZE / SECTOR; sector += 1) {
    const at = SECTOR * (sector + 1) - 1;
    const restored = (page[at] & 0xfc) | ((torn >>> (2 * sector)) & 3);
    if (restored !== page[at]) { page[at] = restored; changed += 1; }
  }
  return changed;
}

function pageHeader(page) {
  return {
    type: page[1],
    slotCount: page.readUInt16LE(22),
    objectId: page.readUInt32LE(24),
    freeData: page.readUInt16LE(30),
    pageId: page.readUInt32LE(32),
  };
}

function plausiblePage(buffer, offset) {
  if (buffer[offset] !== 1 || !PAGE_TYPES.has(buffer[offset + 1])) return false;
  if (buffer.readUInt16LE(offset + 36) !== 1) return false; // فایل دادهٔ اول
  const slotCount = buffer.readUInt16LE(offset + 22);
  const freeData = buffer.readUInt16LE(offset + 30);
  return freeData >= PAGE_HEADER && freeData + 2 * slotCount <= PAGE_SIZE;
}

/** همهٔ صفحه‌های داخل بکاپ، با کلید شمارهٔ صفحه و بیت‌های torn برگردانده. */
function locatePages(buffer) {
  const pages = new Map();
  let duplicates = 0;
  let tornBytes = 0;
  for (let offset = 0; offset + PAGE_SIZE <= buffer.length;) {
    if (!plausiblePage(buffer, offset)) { offset += SECTOR; continue; }
    const page = Buffer.from(buffer.subarray(offset, offset + PAGE_SIZE));
    tornBytes += restoreTornBits(page);
    const pageId = page.readUInt32LE(32);
    if (pages.has(pageId)) duplicates += 1;
    else pages.set(pageId, page);
    offset += PAGE_SIZE;
  }
  return { pages, duplicates, tornBytes };
}

/** وضعیت تخصیص صفحه از روی PFS: بیت 0x40 یعنی صفحه هنوز در اختیار یک شیء است. */
function allocationReader(pages) {
  return (pageId) => {
    const pfsId = pageId < PFS_INTERVAL ? 1 : Math.floor(pageId / PFS_INTERVAL) * PFS_INTERVAL;
    const pfs = pages.get(pfsId);
    if (!pfs || pfs[1] !== 11) return null;
    const recordOffset = pfs.readUInt16LE(PAGE_SIZE - 2);
    const at = recordOffset + 4 + (pageId - (pfsId === 1 ? 0 : pfsId));
    if (recordOffset < PAGE_HEADER || at >= PAGE_SIZE) return null;
    return (pfs[at] & 0x40) !== 0;
  };
}

/**
 * ساختار یک ردیف SQL Server 2000. null یعنی ردیف سالم نیست؛ هیچ مقداری از
 * ردیف ناسالم خوانده نمی‌شود.
 */
function readRecord(page, offset, limit) {
  if (offset < PAGE_HEADER || offset + 4 > limit) return null;
  const statusA = page[offset];
  const kind = (statusA >> 1) & 7;
  const fixedEnd = page.readUInt16LE(offset + 2);
  if (fixedEnd < 4 || offset + fixedEnd > limit) return null;
  let cursor = offset + fixedEnd;
  let columnCount = Infinity;
  let nullBitmap = null;
  if (statusA & 0x10) {
    if (cursor + 2 > limit) return null;
    columnCount = page.readUInt16LE(cursor);
    const bitmapBytes = Math.ceil(columnCount / 8);
    nullBitmap = page.subarray(cursor + 2, cursor + 2 + bitmapBytes);
    cursor += 2 + bitmapBytes;
  }
  const varEnds = [];
  if (statusA & 0x20) {
    if (cursor + 2 > limit) return null;
    const count = page.readUInt16LE(cursor);
    if (cursor + 2 + 2 * count > limit) return null;
    for (let index = 0; index < count; index += 1) varEnds.push(page.readUInt16LE(cursor + 2 + 2 * index) & 0x7fff);
    cursor += 2 + 2 * count;
  }
  let previous = cursor - offset;
  for (const end of varEnds) {
    if (end < previous || offset + end > limit) return null;
    previous = end;
  }
  return { page, offset, kind, fixedEnd, columnCount, nullBitmap, varEnds, varStart: cursor - offset };
}

/** ردیف‌های زندهٔ یک صفحهٔ داده — فقط آنچه آرایهٔ slot نشان می‌دهد. */
function liveRecords(page, stats) {
  const header = pageHeader(page);
  const records = [];
  const limit = PAGE_SIZE - 2 * header.slotCount;
  for (let slot = 0; slot < header.slotCount; slot += 1) {
    const offset = page.readUInt16LE(PAGE_SIZE - 2 - 2 * slot);
    if (offset === 0) continue; // ردیف حذف‌شده
    const record = readRecord(page, offset, limit);
    if (!record) { stats.brokenRecords += 1; continue; }
    // ۰ ردیف اصلی، ۱ ردیف جابه‌جاشده (forwarded). ۲ نشانی ردیف جابه‌جاشده است
    // و دادهٔ خودش را ندارد؛ بقیه ردیف ایندکس یا شبح (ghost) هستند.
    if (record.kind === 0 || record.kind === 1) records.push(record);
    else stats.skippedRecords += 1;
  }
  return records;
}

function isNull(record, column) {
  if (column.colid > record.columnCount) return true;
  if (!record.nullBitmap) return false;
  const bit = column.colid - 1;
  return ((record.nullBitmap[bit >> 3] ?? 0) >> (bit & 7) & 1) === 1;
}

const latinDecoder = new TextDecoder('windows-1256');

function cleanText(text) {
  return text.replace(/\u0000+$/, '').trim();
}

function decodeValue(record, column) {
  if (isNull(record, column)) return null;
  const { page, offset } = record;
  if (column.xoffset > 0) {
    const at = offset + column.xoffset;
    if (column.xoffset + column.length > record.fixedEnd) return null; // ستونی که بعد از ساخت ردیف اضافه شده
    switch (column.xtype) {
      case 48: return page[at];
      case 52: return page.readInt16LE(at);
      case 56: return page.readInt32LE(at);
      case 127: return Number(page.readBigInt64LE(at));
      case 59: return page.readFloatLE(at);
      case 62: return page.readDoubleLE(at);
      case 175: return cleanText(latinDecoder.decode(page.subarray(at, at + column.length)));
      case 239: return cleanText(page.toString('utf16le', at, at + column.length));
      // bit: چند ستون یک بایت را با جای بیت خودشان شریک‌اند.
      case 104: return ((page[at] >> (column.bitpos & 7)) & 1) === 1;
      // decimal/numeric: بایت اول علامت (۱ مثبت)، بقیه عدد صحیح little-endian، تقسیم بر ۱۰ به توان مقیاس.
      case 106: case 108: {
        let magnitude = 0n;
        for (let index = column.length - 1; index >= 1; index -= 1) magnitude = (magnitude << 8n) | BigInt(page[at + index]);
        const value = Number(magnitude) / 10 ** (column.xscale || 0);
        return page[at] === 1 ? value : -value;
      }
      case 60: return (page.readInt32LE(at) * 2 ** 32 + page.readUInt32LE(at + 4)) / 10000;
      case 122: return page.readInt32LE(at) / 10000;
      case 61: return new Date(Date.UTC(1900, 0, 1) + page.readInt32LE(at + 4) * 86_400_000 + Math.round(page.readUInt32LE(at) * 10 / 3)).toISOString();
      case 58: return new Date(Date.UTC(1900, 0, 1) + page.readUInt16LE(at + 2) * 86_400_000 + page.readUInt16LE(at) * 60_000).toISOString();
      case 189: case 173: return page.subarray(at, at + column.length).toString('hex');
      default: return undefined;
    }
  }
  const index = -column.xoffset - 1;
  if (index >= record.varEnds.length) return null;
  const from = offset + (index === 0 ? record.varStart : record.varEnds[index - 1]);
  const to = offset + record.varEnds[index];
  if (column.xtype === 231) return cleanText(page.toString('utf16le', from, to));
  if (column.xtype === 167) return cleanText(latinDecoder.decode(page.subarray(from, to)));
  if (column.xtype === 165) return page.subarray(from, to).toString('hex');
  return undefined;
}

function firstVariableText(record) {
  if (!record.varEnds.length) return '';
  return cleanText(record.page.toString('utf16le', record.offset + record.varStart, record.offset + record.varEnds[0]));
}

/** کاتالوگ جدول‌ها و ستون‌ها از sysobjects و syscolumns خود بکاپ. */
function readCatalog(pagesByObject, stats) {
  const objects = new Map();
  for (const page of pagesByObject.get(SYSOBJECTS) || []) {
    for (const record of liveRecords(page, stats)) {
      if (record.fixedEnd < 10) continue;
      const id = page.readInt32LE(record.offset + 4);
      const xtype = page.toString('latin1', record.offset + 8, record.offset + 10);
      const name = firstVariableText(record);
      if (xtype === 'U ' && name) objects.set(name, id);
    }
  }
  const columns = new Map();
  for (const page of pagesByObject.get(SYSCOLUMNS) || []) {
    for (const record of liveRecords(page, stats)) {
      if (record.fixedEnd < 20) continue;
      const at = record.offset;
      const column = {
        objectId: page.readInt32LE(at + 4),
        xtype: page[at + 8],
        length: page.readInt16LE(at + 12),
        colid: page.readInt16LE(at + 16),
        xoffset: page.readInt16LE(at + 18),
        // دقت و مقیاس decimal و جای بیت در بایت مشترک ستون‌های bit.
        xprec: page[at + 14],
        xscale: page[at + 15],
        bitpos: page[at + 20],
        name: firstVariableText(record),
      };
      if (!columns.has(column.objectId)) columns.set(column.objectId, []);
      columns.get(column.objectId).push(column);
    }
  }
  return { objects, columns };
}

function readTable(name, spec, context) {
  const objectId = context.catalog.objects.get(name);
  if (objectId == null) {
    if (spec.missingTableAllowed) return { rows: [], missing: true };
    throw parseError(`جدول ${name} در این بکاپ نیست؛ این فایل بکاپ پارسیانِ شناخته‌شده نیست.`, 'PARSIAN_BACKUP_UNSUPPORTED');
  }
  const byName = new Map((context.catalog.columns.get(objectId) || []).map((column) => [column.name.toLowerCase(), column]));
  const wanted = [];
  for (const columnName of [...spec.required, ...spec.optional]) {
    const column = byName.get(columnName.toLowerCase());
    if (!column) {
      if (spec.required.includes(columnName)) throw parseError(`ستون ${columnName} در جدول ${name} پیدا نشد؛ نسخهٔ این بکاپ پشتیبانی نمی‌شود.`, 'PARSIAN_BACKUP_UNSUPPORTED');
      continue;
    }
    wanted.push([columnName, column]);
  }
  const rows = [];
  let livePages = 0;
  let stalePages = 0;
  for (const page of context.pagesByObject.get(objectId) || []) {
    const allocated = context.allocated(pageHeader(page).pageId);
    if (allocated === null) throw parseError('نقشهٔ تخصیص صفحه‌ها (PFS) در بکاپ پیدا نشد؛ بدون آن ردیف کهنه از زنده جدا نمی‌شود.', 'PARSIAN_BACKUP_UNSUPPORTED');
    if (!allocated) { stalePages += 1; continue; }
    livePages += 1;
    for (const record of liveRecords(page, context.stats)) {
      const row = {};
      for (const [columnName, column] of wanted) {
        const value = decodeValue(record, column);
        if (value === undefined) throw parseError(`نوع ستون ${name}.${columnName} (${column.xtype}) شناخته نیست.`, 'PARSIAN_BACKUP_UNSUPPORTED');
        row[columnName] = value;
      }
      rows.push(row);
    }
  }
  context.parsed.meta.pagesByTable[name] = { live: livePages, stale: stalePages };
  return { rows, missing: false };
}

/**
 * نقطهٔ ورود: خواندن کامل بکاپ و برگرداندن کدینگ و اسناد آن.
 * خروجی برای «پیش‌نمایش» و «ثبت» یکسان است؛ تصمیم ورود با لایهٔ بالاتر.
 */
export function parseParsianBackup(buffer, { fileName = '' } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 2 * PAGE_SIZE) {
    throw parseError('فایل ارسالی خیلی کوچک‌تر از آن است که بکاپ پارسیان باشد.');
  }
  if (!buffer.subarray(0, 4096).includes(Buffer.from('TAPE', 'ascii'))) {
    throw parseError('امضای کانتینر بکاپ (MTF/TAPE) پیدا نشد؛ این فایل بکاپ پارسیان نیست.', 'PARSIAN_BACKUP_NOT_MTF');
  }
  try {
    return parseLocatedBackup(buffer, fileName);
  } catch (error) {
    if (error.code) throw error;
    // خطای خواندن بیرون از مرز بافر یعنی فایل ناقص یا دست‌خورده است، نه خطای سرور.
    throw parseError(`ساختار بکاپ خوانا نیست: ${error.message}`);
  }
}

function parseLocatedBackup(buffer, fileName) {
  const { pages, duplicates, tornBytes } = locatePages(buffer);
  const pagesByObject = new Map();
  for (const page of pages.values()) {
    const header = pageHeader(page);
    if (header.type !== DATA_PAGE) continue;
    if (!pagesByObject.has(header.objectId)) pagesByObject.set(header.objectId, []);
    pagesByObject.get(header.objectId).push(page);
  }
  const stats = { brokenRecords: 0, skippedRecords: 0 };
  const catalog = readCatalog(pagesByObject, stats);
  if (!catalog.objects.size) throw parseError('هیچ جدولی در بکاپ شناسایی نشد؛ فایل ناقص یا رمزشده است.');

  const warnings = [];
  const parsed = {
    meta: {
      fileName: String(fileName || ''),
      sizeBytes: buffer.length,
      sha256: createHash('sha256').update(buffer).digest('hex'),
      container: 'MTF (Microsoft Tape Format) — بکاپ SQL Server 2000',
      pages: pages.size,
      tablesDiscovered: catalog.objects.size,
      pagesByTable: {},
    },
    chart: { kol: [], moeen: [], tafsili: [], groups: [], designated: [] },
    documents: { rows: [], vouchers: [] },
    stats: { ...stats, tornBytes, duplicatePages: duplicates, rows: {} },
    warnings,
  };
  const context = { catalog, pagesByObject, allocated: allocationReader(pages), stats, parsed };
  const tables = {};
  for (const [name, spec] of Object.entries(TABLES)) {
    tables[name] = readTable(name, spec, context);
    parsed.stats.rows[name] = tables[name].rows.length;
  }
  Object.assign(parsed.stats, { brokenRecords: stats.brokenRecords, skippedRecords: stats.skippedRecords });
  if (duplicates) throw parseError(`${duplicates} صفحه در بکاپ دو بار آمده است؛ ردیف زنده قابل تشخیص نیست.`, 'PARSIAN_BACKUP_INCONSISTENT');
  if (stats.brokenRecords) warnings.push(`${stats.brokenRecords} ردیف ساختار سالم نداشت و خوانده نشد.`);

  const groups = new Map(tables.tbl_ACCGroup.rows.map((row) => [row.Code, row.CName || '']));
  parsed.chart.groups = [...groups].map(([code, name]) => ({ code, name }));
  parsed.chart.kol = tables.tbl_Kol.rows.map((row) => ({
    code: row.Code, name: row.CName || '',
    group: row.GroupCode ?? null, groupName: row.GroupCode == null ? '' : groups.get(row.GroupCode) || '',
    temporary: row.iType == null ? null : row.iType === 1,
  }));
  parsed.chart.moeen = tables.tbl_Moeen.rows.map((row) => ({ kol: row.KolCode, code: row.Code, name: row.CName || '' }));
  for (const [table, keys] of Object.entries(DESIGNATED)) {
    const [row] = tables[table].rows;
    if (!row) continue;
    for (const key of keys) {
      const kol = row[`${key}_K`];
      if (kol == null || kol === 0) continue;
      parsed.chart.designated.push({ key, kol, moeen: row[`${key}_M`] ?? 0, taf: row[`${key}_T`] ?? 0 });
    }
  }
  parsed.chart.tafsili = tables.tbl_Tafsili.rows.map((row) => ({ kol: row.KolCode, moeen: row.MoeenCode, code: row.Code, name: row.CName || '' }));
  if (!parsed.chart.kol.length) throw parseError('جدول کدینگ (کل) در بکاپ خالی است؛ استخراج ممکن نیست.');

  const ids = new Set();
  for (const row of tables.tbl_Document.rows) {
    if (ids.has(row.ID)) throw parseError(`ردیف سند با شناسهٔ ${row.ID} دو بار در بکاپ زنده است؛ بکاپ ناسازگار است و چیزی وارد نمی‌شود.`, 'PARSIAN_BACKUP_INCONSISTENT');
    ids.add(row.ID);
    parsed.documents.rows.push({
      id: row.ID, sanad: row.Sanad_Num, date: row.SanadDate || '',
      kol: row.KolCode, moeen: row.MoeenCode, taf: row.TafsiliCode || 0,
      bed: row.Bed ?? 0, bes: row.Bes ?? 0,
      comment: row.Comment || '', sanadComment: row.SanadComment || '',
      factor: row.Factor_Num || 0,
    });
  }
  if (!parsed.documents.rows.length) warnings.push('هیچ ردیف سندی در بکاپ نیست؛ فقط کدینگ وارد می‌شود.');
  parsed.documents.vouchers = buildVouchers(parsed.documents.rows);
  parsed.extras = readExtras(context, warnings);
  return parsed;
}

/**
 * کالا، کارت طرف حساب، فاکتورها و مشخصات شرکت. هر جدول جدا خوانده می‌شود و
 * خطای یکی فقط همان را کنار می‌گذارد؛ اسناد و کدینگ هرگز به این‌ها وابسته نیستند.
 */
function readExtras(context, warnings) {
  const tables = {};
  for (const [name, spec] of Object.entries(EXTRA_TABLES)) {
    try {
      tables[name] = readTable(name, spec, context).rows;
      context.parsed.stats.rows[name] = tables[name].length;
    } catch (error) {
      tables[name] = [];
      warnings.push(`جدول ${name} خوانده نشد (${error.message})؛ بقیهٔ ورود دست نمی‌خورد.`);
    }
  }
  const groups = new Map(tables.tbl_GoodsGroup.map((row) => [row.Code, { name: row.CName || '', service: row.IsService === true }]));
  const goods = tables.tbl_Goods.filter((row) => row.CName).map((row) => ({
    code: row.Code, name: row.CName, unit: row.UnitName_1 || '', price: Number(row.Price_1) || 0,
    vatPercent: Number(row.VATPercent) || 0, barcode: row.Barcode || '',
    group: groups.get(row.GroupCode)?.name || '', service: groups.get(row.GroupCode)?.service || false,
  }));
  const cards = tables.tbl_Telephone.filter((row) => row.CName).map((row) => ({
    kol: row.KolCode || 0, moeen: row.MoeenCode || 0, taf: row.TafsiliCode || 0, name: row.CName,
    tel: row.Tel || '', mobile: row.Mobile || '', address: row.Address || '',
    economicCode: row.CodeEco || '', nationalId: row.CodeNat || '', postalCode: row.CodePost || '',
  }));
  // فاکتور از ردیف‌هایش ساخته می‌شود. tbl_FactNum فقط گزارش ساخت است و جمعش پس از
  // اصلاح به‌روز نمی‌شود؛ مبلغ درست همان ردیف‌ها و ردیف طرف حساب در سند است.
  const kinds = new Map(tables.tbl_FactorKind.map((row) => [row.Code, row.CName || '']));
  const byFactor = new Map();
  for (const row of tables.tbl_Factor) {
    const key = `${row.TitleCode}:${row.Factor_Num}`;
    if (!byFactor.has(key)) {
      byFactor.set(key, {
        title: row.TitleCode, titleName: kinds.get(row.TitleCode) || '', number: row.Factor_Num, date: row.Factor_Date || '',
        sanad: row.Sanad_Num || 0, comment: row.FactorComment || '', dueDate: row.SarResid_Date || '', lines: [],
      });
    }
    const invoice = byFactor.get(key);
    if (!invoice.sanad && row.Sanad_Num) invoice.sanad = row.Sanad_Num;
    invoice.lines.push({ id: row.ID, goodsCode: row.GoodsCode ?? null, quantity: Number(row.Tedad) || 0, unitPrice: Number(row.Price) || 0,
      discount: Number(row.Discont) || 0, comment: row.GoodsComment || '' });
  }
  for (const invoice of byFactor.values()) invoice.lines.sort((first, second) => first.id - second.id);
  const [company] = tables.tbl_CoSpec;
  const cheques = tables.tbl_Check.map((row) => ({
    id: row.ID, kind: row.Chk_Kind, status: row.Vos_Pas, active: row.IsActive ?? null,
    money: Number(row.Money) || 0, serial: row.Chk_Num ?? '', sayad: row.Sayad || '', bank: row.Bank || '', comment: row.Comment || '',
    registeredDate: row.ExpDate || '', dueDate: row.RecDate || '', settledDate: row.Giv_Date || '',
    sanad: row.Sanad_Num || 0, settleSanad: row.Sanad_Num_VosolPas || 0,
    accKol: row.Acc_K || 0, accMoeen: row.Acc_M || 0, accTaf: row.Acc_T || 0,
    tarafKol: row.Taraf_K || 0, tarafMoeen: row.Taraf_M || 0,
    bankKol: row.Bank_K || 0, bankMoeen: row.Bank_M || 0, bankTaf: row.Bank_T || 0,
  }));
  const chequeHistory = tables.tbl_RecycleCheck.map((row) => ({
    id: row.ID ?? 0, chequeId: row.CHK_ID, status: row.Vos_Pas, active: row.IsActive ?? null,
    registeredDate: row.ExpDate || '', settledDate: row.Giv_Date || '', sanad: row.Sanad_Num || 0,
    accKol: row.Acc_K || 0, accMoeen: row.Acc_M || 0, accTaf: row.Acc_T || 0,
  })).sort((first, second) => first.id - second.id);
  return {
    goods, cards, cheques, chequeHistory,
    invoices: [...byFactor.values()].sort((first, second) => first.title - second.title || first.number - second.number),
    company: company ? {
      economicCode: company.ECOcode || '', nationalId: company.Code || '', postalCode: company.PostalCode || '',
      address: company.Address || '', phone: company.Tel || '', province: company.Estate || '', city: company.City || '',
    } : null,
  };
}

/** گروه‌بندی ردیف‌های سند بر شمارهٔ سند پارسیان، مرتب بر تاریخ و شماره. مبلغ‌ها دست نمی‌خورند. */
function buildVouchers(rows) {
  const bySanad = new Map();
  for (const row of rows) {
    if (!bySanad.has(row.sanad)) bySanad.set(row.sanad, []);
    bySanad.get(row.sanad).push(row);
  }
  return [...bySanad.entries()]
    .map(([sanad, lines]) => {
      lines.sort((first, second) => first.id - second.id);
      const dates = [...new Set(lines.map((line) => line.date))].sort();
      const bedTotal = lines.reduce((sum, line) => sum + line.bed, 0);
      const besTotal = lines.reduce((sum, line) => sum + line.bes, 0);
      return {
        sanad, dates, date: dates[0] || '', lines, bedTotal, besTotal,
        validDate: dates.length === 1 && JALALI_DATE.test(dates[0]),
        balanced: bedTotal === besTotal && bedTotal > 0,
      };
    })
    .sort((first, second) => (first.date === second.date ? first.sanad - second.sanad : first.date < second.date ? -1 : 1));
}
