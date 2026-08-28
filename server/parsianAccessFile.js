// نوشتن فایل «انتقال اسناد» پارسیان — قالب Access/Jet 4.
//
// پارسیان سند را نه با CSV می‌گیرد و نه با اکسل، بلکه با یک دیتابیس Access
// می‌گیرد (امکانات ← سامانه تبادل اطلاعات ← سامانه تبادل اطلاعات اسناد). این
// ماژول آن فایل را می‌سازد، ولی از صفر نمی‌سازدش.
//
// روش: **الگو**. دفتر یک بار از پارسیانِ خودش یک فایل انتقال می‌گیرد و همان
// می‌شود الگو. حساب‌یار الگو را برمی‌دارد و فقط جدول tbl_Document را داخلش
// بازنویسی می‌کند. یعنی تمام بایت‌های اطراف دادهٔ ما را خودِ پارسیان ساخته و ما
// هیچ ساختاری را جعل نمی‌کنیم — همان مرزی که در فاز ۸ گذاشته شد.
//
// همهٔ آفست‌های این فایل از خواندن یک خروجی واقعی پارسیان درآمده‌اند و در
// test/parsian-access-file.test.js با بایت‌های همان خروجی قفل شده‌اند.

const PAGE_SIZE = 4096;
const JET_SIGNATURE = 'Standard Jet DB';

// آفست‌های سرصفحهٔ صفحهٔ تعریف جدول (TDEF)
const TDEF_ROW_COUNT = 16;
const TDEF_AUTONUMBER = 20;
const TDEF_TABLE_TYPE = 40;
const TDEF_NUM_VAR_COLS = 43;
const TDEF_NUM_COLS = 45;
const TDEF_NUM_REAL_IDX = 51;
const TDEF_ROW_PAGE_MAP = 56;
const TDEF_FREE_SPACE_MAP = 60;
const TDEF_INDEX_BLOCK = 63;
const TDEF_INDEX_ENTRY = 12;
const TDEF_COLUMN_ENTRY = 25;

// آفست‌های صفحهٔ داده
const DATA_FREE_SPACE = 2;
const DATA_OWNER = 4;
const DATA_ROW_COUNT = 12;
const DATA_ROW_OFFSETS = 14;

// آفست‌های صفحهٔ برگ ایندکس
const INDEX_ENTRY_MASK = 27;
const INDEX_ENTRY_START = 480;
const INDEX_ENTRY_SIZE = 9; // 0x7f + عدد چهاربایتی + صفحهٔ سه‌بایتی + شمارهٔ ردیف
const INDEX_CAPACITY = Math.floor((PAGE_SIZE - INDEX_ENTRY_START) / INDEX_ENTRY_SIZE);

const TYPE_BOOLEAN = 0x01;
const TYPE_INT = 0x03;
const TYPE_LONG = 0x04;
const TYPE_DOUBLE = 0x07;
const TYPE_TEXT = 0x0a;

const DATE_SHAPE = /^\d{4}\/\d{2}\/\d{2}$/;

function transferError(message, code = 'PARSIAN_TRANSFER_INVALID', status = 400) {
  return Object.assign(new Error(message), { code, status });
}

export function isAccessDatabase(buffer) {
  return Buffer.isBuffer(buffer)
    && buffer.length > PAGE_SIZE
    && buffer.subarray(4, 4 + JET_SIGNATURE.length).toString('latin1') === JET_SIGNATURE;
}

function pageOffset(page) { return page * PAGE_SIZE; }

function readColumns(buffer, tdefPage) {
  const base = pageOffset(tdefPage);
  const numCols = buffer.readUInt16LE(base + TDEF_NUM_COLS);
  const numRealIdx = buffer.readInt32LE(base + TDEF_NUM_REAL_IDX);
  let cursor = base + TDEF_INDEX_BLOCK + TDEF_INDEX_ENTRY * numRealIdx;
  const columns = [];
  for (let i = 0; i < numCols; i++) {
    const def = buffer.subarray(cursor, cursor + TDEF_COLUMN_ENTRY);
    columns.push({
      type: def[0],
      varIndex: def.readUInt16LE(7),
      colId: def.readUInt16LE(9),
      fixedOffset: def.readUInt16LE(21),
      length: def.readUInt16LE(23),
    });
    cursor += TDEF_COLUMN_ENTRY;
  }
  for (const column of columns) {
    const length = buffer.readUInt16LE(cursor); cursor += 2;
    column.name = buffer.subarray(cursor, cursor + length).toString('utf16le');
    cursor += length;
  }
  return columns;
}

/**
 * الگو را می‌خواند و می‌سنجد. اگر فایل، فایل انتقال پارسیان نباشد، همین‌جا
 * متوقف می‌شود — نه بعداً وسط نوشتن.
 */
export function readParsianTemplate(buffer) {
  if (!isAccessDatabase(buffer)) {
    throw transferError('این فایل، فایل انتقال پارسیان نیست. یک بار از پارسیان خودتان «انتقال اسناد به فایل» بگیرید و همان فایل را به‌عنوان الگو بدهید.', 'PARSIAN_TEMPLATE_NOT_ACCESS');
  }
  const pageCount = Math.floor(buffer.length / PAGE_SIZE);
  let tdefPage = -1;
  for (let page = 0; page < pageCount; page++) {
    const base = pageOffset(page);
    if (buffer[base] !== 0x02 || buffer[base + TDEF_TABLE_TYPE] !== 0x4e) continue;
    const columns = readColumns(buffer, page);
    if (columns.some((column) => column.name === 'SanadDate') && columns.some((column) => column.name === 'KolCode')) {
      tdefPage = page;
      break;
    }
  }
  if (tdefPage < 0) throw transferError('جدول اسناد (tbl_Document) در فایل الگو پیدا نشد.', 'PARSIAN_TEMPLATE_NO_DOCUMENT_TABLE');

  const base = pageOffset(tdefPage);
  const columns = readColumns(buffer, tdefPage);
  const byName = new Map(columns.map((column) => [column.name, column]));
  for (const required of ['ID', 'Sanad_Num', 'SanadDate', 'KolCode', 'MoeenCode', 'TafsiliCode', 'Bed', 'Bes']) {
    if (!byName.has(required)) throw transferError(`ستون «${required}» در جدول اسناد فایل الگو نیست.`, 'PARSIAN_TEMPLATE_COLUMN_MISSING');
  }

  const dataPages = [];
  const indexPages = [];
  for (let page = 0; page < pageCount; page++) {
    const offset = pageOffset(page);
    if (buffer.readInt32LE(offset + DATA_OWNER) !== tdefPage) continue;
    if (buffer[offset] === 0x01) dataPages.push(page);
    if (buffer[offset] === 0x04) indexPages.push(page);
  }
  if (!dataPages.length) throw transferError('فایل الگو هیچ صفحهٔ دادهٔ آماده‌ای برای جدول اسناد ندارد.', 'PARSIAN_TEMPLATE_NO_DATA_PAGE');
  if (indexPages.length > 1) {
    throw transferError('جدول اسناد این الگو بیش از یک صفحهٔ ایندکس دارد و هنوز پشتیبانی نمی‌شود. یک الگو با اسناد کمتر بگیرید.', 'PARSIAN_TEMPLATE_MULTI_INDEX');
  }

  return {
    tdefPage,
    columns,
    columnsByName: byName,
    numCols: columns.length,
    numVarCols: buffer.readUInt16LE(base + TDEF_NUM_VAR_COLS),
    dataPages,
    indexPage: indexPages.length ? indexPages[0] : null,
    rowCount: buffer.readInt32LE(base + TDEF_ROW_COUNT),
    pageCount,
  };
}

function usageMapPointer(buffer, tdefPage, offset) {
  const value = buffer.readInt32LE(pageOffset(tdefPage) + offset);
  return { page: value & 0x00ffffff, row: (value >>> 24) & 0xff };
}

function usageMapRecord(buffer, pointer) {
  const base = pageOffset(pointer.page);
  const start = buffer.readUInt16LE(base + DATA_ROW_OFFSETS + pointer.row * 2) & 0x1fff;
  const end = pointer.row === 0
    ? PAGE_SIZE
    : (buffer.readUInt16LE(base + DATA_ROW_OFFSETS + (pointer.row - 1) * 2) & 0x1fff);
  return { start: base + start, end: base + end };
}

// نقشهٔ استفادهٔ درون‌خطی: یک بایت نوع، شمارهٔ صفحهٔ شروع، و بعد بیت‌نقشه.
function markPageUsed(buffer, record, page) {
  const startPage = buffer.readInt32LE(record.start + 1);
  const bit = page - startPage;
  const byteIndex = record.start + 5 + (bit >> 3);
  if (bit < 0 || byteIndex >= record.end) {
    throw transferError('فایل الگو برای این تعداد سند جا ندارد. الگوی بزرگ‌تری از پارسیان بگیرید یا سندها را به چند فایل بشکنید.', 'PARSIAN_TEMPLATE_TOO_SMALL');
  }
  buffer[byteIndex] |= 1 << (bit & 7);
}

export function encodeRow(template, values) {
  const { columns, numCols, numVarCols } = template;
  const fixedLength = columns.reduce(
    (max, column) => (column.type === TYPE_TEXT ? max : Math.max(max, column.fixedOffset + column.length)),
    0,
  );
  const fixed = Buffer.alloc(fixedLength);
  const varData = new Array(numVarCols).fill(null);
  const nullMask = Buffer.alloc(Math.ceil(numCols / 8));
  const setBit = (colId) => { nullMask[(colId - 1) >> 3] |= 1 << ((colId - 1) & 7); };

  for (const column of columns) {
    const value = values[column.name];
    if (column.type === TYPE_BOOLEAN) { if (value) setBit(column.colId); continue; }
    if (value === undefined || value === null) continue; // بیت خاموش یعنی NULL
    setBit(column.colId);
    if (column.type === TYPE_TEXT) { varData[column.varIndex] = Buffer.from(String(value), 'utf16le'); continue; }
    switch (column.type) {
      case TYPE_INT: fixed.writeInt16LE(Number(value), column.fixedOffset); break;
      case TYPE_LONG: fixed.writeInt32LE(Number(value), column.fixedOffset); break;
      case TYPE_DOUBLE: fixed.writeDoubleLE(Number(value), column.fixedOffset); break;
      default: throw transferError(`نوع ستون «${column.name}» پشتیبانی نمی‌شود.`, 'PARSIAN_TEMPLATE_COLUMN_TYPE');
    }
  }

  // ترتیب: تعداد ستون، دادهٔ ثابت، دادهٔ متغیر، آفست‌ها، تعداد متغیر، ماسک null
  const varBuffers = varData.map((item) => item || Buffer.alloc(0));
  const starts = [];
  let cursor = 2 + fixedLength;
  for (const item of varBuffers) { starts.push(cursor); cursor += item.length; }
  starts.push(cursor); // پایان دادهٔ متغیر

  const offsetsLength = (numVarCols + 1) * 2;
  const total = cursor + offsetsLength + 2 + nullMask.length;
  const row = Buffer.alloc(total);
  row.writeUInt16LE(numCols, 0);
  fixed.copy(row, 2);
  varBuffers.forEach((item, index) => item.copy(row, starts[index]));
  // آفست‌ها وارونه ذخیره می‌شوند: خانهٔ j برابر starts[numVarCols - j] است.
  for (let j = 0; j <= numVarCols; j++) row.writeUInt16LE(starts[numVarCols - j], cursor + j * 2);
  row.writeUInt16LE(numVarCols, cursor + offsetsLength);
  nullMask.copy(row, cursor + offsetsLength + 2);
  return row;
}

function resetDataPage(buffer, page, tdefPage) {
  const base = pageOffset(page);
  buffer.fill(0, base, base + PAGE_SIZE);
  buffer[base] = 0x01;
  buffer[base + 1] = 0x01;
  buffer.writeInt32LE(tdefPage, base + DATA_OWNER);
  buffer.writeUInt16LE(PAGE_SIZE - DATA_ROW_OFFSETS, base + DATA_FREE_SPACE);
}

function writeRowsToPage(buffer, page, rows) {
  const base = pageOffset(page);
  let bottom = PAGE_SIZE;
  rows.forEach((row, index) => {
    bottom -= row.length;
    row.copy(buffer, base + bottom);
    buffer.writeUInt16LE(bottom, base + DATA_ROW_OFFSETS + index * 2);
  });
  buffer.writeUInt16LE(rows.length, base + DATA_ROW_COUNT);
  const used = DATA_ROW_OFFSETS + rows.length * 2 + rows.reduce((sum, row) => sum + row.length, 0);
  buffer.writeUInt16LE(PAGE_SIZE - used, base + DATA_FREE_SPACE);
}

function writeIndexPage(buffer, page, tdefPage, entries) {
  const base = pageOffset(page);
  buffer.fill(0, base, base + PAGE_SIZE);
  buffer[base] = 0x04;
  buffer[base + 1] = 0x01;
  buffer.writeInt32LE(tdefPage, base + DATA_OWNER);
  let cursor = INDEX_ENTRY_START;
  for (const entry of entries) {
    buffer[base + cursor] = 0x7f;
    // عدد صحیح در ایندکس، big-endian و با بیت علامت وارونه ذخیره می‌شود
    buffer.writeUInt32BE((entry.value ^ 0x80000000) >>> 0, base + cursor + 1);
    buffer[base + cursor + 5] = (entry.page >> 16) & 0xff;
    buffer[base + cursor + 6] = (entry.page >> 8) & 0xff;
    buffer[base + cursor + 7] = entry.page & 0xff;
    buffer[base + cursor + 8] = entry.row;
    cursor += INDEX_ENTRY_SIZE;
    // ماسک، پایان هر ورودی را علامت می‌زند
    const bit = cursor - INDEX_ENTRY_START;
    buffer[base + INDEX_ENTRY_MASK + (bit >> 3)] |= 1 << (bit & 7);
  }
  buffer.writeUInt16LE(PAGE_SIZE - cursor, base + DATA_FREE_SPACE);
}

export function validateDocuments(documents) {
  if (!Array.isArray(documents) || !documents.length) {
    throw transferError('هیچ سندی برای انتقال داده نشده است.', 'PARSIAN_TRANSFER_EMPTY');
  }
  const errors = [];
  documents.forEach((document, index) => {
    const label = `سند ${index + 1}`;
    const date = String((document && document.date) || '').trim();
    if (!DATE_SHAPE.test(date)) {
      errors.push(`${label}: تاریخ باید دقیقاً به شکل ۱۴۰۲/۰۶/۰۵ باشد. پارسیان ماه را از کاراکتر ششم می‌خواند و تاریخ بدون صفر گزارش‌های ماهانه‌اش را بی‌صدا خراب می‌کند.`);
    }
    const lines = Array.isArray(document && document.lines) ? document.lines : [];
    if (lines.length < 2) { errors.push(`${label}: سند باید حداقل دو ردیف داشته باشد.`); return; }
    let debit = 0;
    let credit = 0;
    lines.forEach((line, lineIndex) => {
      const position = `${label} ردیف ${lineIndex + 1}`;
      const kol = Number(line && line.kolCode);
      const moeen = Number(line && line.moeenCode);
      if (!Number.isInteger(kol) || kol <= 0) errors.push(`${position}: کد کل ندارد. فایل انتقال حساب نمی‌سازد؛ کد باید از قبل در پارسیان مقصد باشد.`);
      if (!Number.isInteger(moeen) || moeen <= 0) errors.push(`${position}: کد معین ندارد.`);
      const lineDebit = Number((line && line.debit) || 0);
      const lineCredit = Number((line && line.credit) || 0);
      if (lineDebit < 0 || lineCredit < 0) errors.push(`${position}: مبلغ منفی پذیرفته نمی‌شود؛ به‌جایش سمت دیگر را بنویسید.`);
      if (lineDebit > 0 && lineCredit > 0) errors.push(`${position}: یک ردیف نمی‌تواند هم بدهکار باشد هم بستانکار.`);
      debit += lineDebit;
      credit += lineCredit;
    });
    if (debit !== credit) {
      errors.push(`${label}: بدهکار ${debit} با بستانکار ${credit} برابر نیست. پارسیان سند نامتوازن را می‌پذیرد و خطا ماه‌ها بعد در تراز مشتری پیدا می‌شود، پس انتقال همین‌جا متوقف می‌شود.`);
    }
  });
  if (errors.length) {
    throw Object.assign(
      transferError('سندها برای انتقال به پارسیان آماده نیستند.', 'PARSIAN_TRANSFER_ROWS_INVALID'),
      { details: { errors } },
    );
  }
}

/**
 * ردیف‌های tbl_Document را از سندها می‌سازد.
 *
 * شمارهٔ سند فایل فقط کلید گروه‌بندی ردیف‌هاست؛ پارسیان موقع ورود دورش می‌ریزد
 * و خودش شماره می‌دهد. برای همین شمارهٔ سند حساب‌یار باید در شرح برود.
 */
export function documentRows(documents) {
  const rows = [];
  documents.forEach((document, index) => {
    for (const line of document.lines) {
      rows.push({
        ID: rows.length + 1,
        Sanad_Num: index + 1,
        SanadDate: String(document.date).trim(),
        KolCode: Number(line.kolCode),
        MoeenCode: Number(line.moeenCode),
        TafsiliCode: Number(line.tafsiliCode || 0),
        Comment: String(line.comment != null ? line.comment : (document.comment || '')),
        Bed: Number(line.debit || 0),
        Bes: Number(line.credit || 0),
        IsNote: false,
        Tick: false,
        SanadComment: String(document.comment || ''),
      });
    }
  });
  return rows;
}

/**
 * فایل انتقال را می‌سازد و برمی‌گرداند.
 *
 * `documents`: [{ date, comment, lines: [{ kolCode, moeenCode, tafsiliCode, debit, credit, comment }] }]
 *
 * مبلغ‌ها همان عددی نوشته می‌شوند که داده می‌شود؛ این ماژول واحد را تبدیل
 * نمی‌کند، چون پارسیان هیچ‌جا واحد را ذخیره نمی‌کند و حدس‌زدنش خطای ده‌برابری است.
 */
export function buildParsianTransfer({ template: templateBuffer, documents } = {}) {
  validateDocuments(documents);
  let buffer = Buffer.from(templateBuffer);
  const template = readParsianTemplate(buffer);
  const rows = documentRows(documents);

  if (rows.length > INDEX_CAPACITY) {
    throw transferError(`این فایل حداکثر ${INDEX_CAPACITY} ردیف می‌گیرد و ${rows.length} ردیف داده شده است. سندها را به چند فایل بشکنید.`, 'PARSIAN_TRANSFER_TOO_MANY_ROWS');
  }

  const encoded = rows.map((values) => encodeRow(template, values));
  const rowMapPointer = usageMapPointer(buffer, template.tdefPage, TDEF_ROW_PAGE_MAP);
  const freeMapPointer = usageMapPointer(buffer, template.tdefPage, TDEF_FREE_SPACE_MAP);

  for (const page of template.dataPages) resetDataPage(buffer, page, template.tdefPage);

  // بسته‌بندی ردیف‌ها در صفحه‌ها؛ صفحهٔ تازه به انتهای فایل اضافه می‌شود.
  const pages = [];
  let current = { page: template.dataPages[0], rows: [], used: DATA_ROW_OFFSETS };
  let nextTemplatePage = 1;
  let appendPage = template.pageCount;
  const extra = [];
  for (const row of encoded) {
    if (current.used + row.length + 2 > PAGE_SIZE) {
      pages.push(current);
      let page;
      if (nextTemplatePage < template.dataPages.length) {
        page = template.dataPages[nextTemplatePage++];
      } else {
        page = appendPage++;
        extra.push(page);
      }
      current = { page, rows: [], used: DATA_ROW_OFFSETS };
    }
    current.rows.push(row);
    current.used += row.length + 2;
  }
  pages.push(current);

  if (extra.length) buffer = Buffer.concat([buffer, Buffer.alloc(extra.length * PAGE_SIZE)]);
  for (const page of extra) resetDataPage(buffer, page, template.tdefPage);

  const rowMap = usageMapRecord(buffer, rowMapPointer);
  const freeMap = usageMapRecord(buffer, freeMapPointer);
  const entries = [];
  for (const item of pages) {
    writeRowsToPage(buffer, item.page, item.rows);
    markPageUsed(buffer, rowMap, item.page);
    markPageUsed(buffer, freeMap, item.page);
    item.rows.forEach((unused, rowIndex) => {
      entries.push({ value: entries.length + 1, page: item.page, row: rowIndex });
    });
  }

  if (template.indexPage !== null) writeIndexPage(buffer, template.indexPage, template.tdefPage, entries);

  const tdefBase = pageOffset(template.tdefPage);
  buffer.writeInt32LE(rows.length, tdefBase + TDEF_ROW_COUNT);
  buffer.writeInt32LE(rows.length, tdefBase + TDEF_AUTONUMBER);

  return buffer;
}

function decodeRow(buffer, start, end, template) {
  const { columns, numCols, numVarCols } = template;
  if (buffer.readUInt16LE(start) !== numCols) return null;
  const nullMaskSize = Math.ceil(numCols / 8);
  const nullMask = buffer.subarray(end - nullMaskSize, end);
  if (buffer.readUInt16LE(end - nullMaskSize - 2) !== numVarCols) return null;
  const offsetsBase = end - nullMaskSize - 2 - (numVarCols + 1) * 2;
  const starts = [];
  for (let j = 0; j <= numVarCols; j++) starts[numVarCols - j] = buffer.readUInt16LE(offsetsBase + j * 2);
  const notNull = (colId) => ((nullMask[(colId - 1) >> 3] >> ((colId - 1) & 7)) & 1) === 1;

  const row = {};
  for (const column of columns) {
    if (column.type === TYPE_BOOLEAN) { row[column.name] = notNull(column.colId); continue; }
    if (!notNull(column.colId)) { row[column.name] = null; continue; }
    if (column.type === TYPE_TEXT) {
      const from = start + starts[column.varIndex];
      const to = start + starts[column.varIndex + 1];
      row[column.name] = to > from ? buffer.subarray(from, to).toString('utf16le') : '';
      continue;
    }
    const at = start + 2 + column.fixedOffset;
    switch (column.type) {
      case TYPE_INT: row[column.name] = buffer.readInt16LE(at); break;
      case TYPE_LONG: row[column.name] = buffer.readInt32LE(at); break;
      case TYPE_DOUBLE: row[column.name] = buffer.readDoubleLE(at); break;
      default: row[column.name] = null;
    }
  }
  return row;
}

/**
 * سندهای یک فایل انتقال پارسیان را می‌خواند.
 *
 * ردیف‌ها با `Sanad_Num` گروه می‌شوند، چون سند در این قالب سرصفحه ندارد و
 * شماره و تاریخ روی هر ردیف تکرار می‌شوند.
 */
export function readParsianDocuments(buffer) {
  const template = readParsianTemplate(buffer);
  const rows = [];
  for (const page of template.dataPages) {
    const base = pageOffset(page);
    const count = buffer.readUInt16LE(base + DATA_ROW_COUNT);
    const offsets = [];
    for (let i = 0; i < count; i++) offsets.push(buffer.readUInt16LE(base + DATA_ROW_OFFSETS + i * 2));
    offsets.forEach((offset, index) => {
      if (offset & 0xc000) return; // ردیف پاک‌شده یا سرریز
      const end = base + (index === 0 ? PAGE_SIZE : (offsets[index - 1] & 0x1fff));
      const row = decodeRow(buffer, base + offset, end, template);
      if (row) rows.push(row);
    });
  }
  rows.sort((left, right) => left.ID - right.ID);

  const byNumber = new Map();
  for (const row of rows) {
    if (!byNumber.has(row.Sanad_Num)) {
      byNumber.set(row.Sanad_Num, { number: row.Sanad_Num, date: row.SanadDate, comment: row.SanadComment || '', lines: [] });
    }
    byNumber.get(row.Sanad_Num).lines.push({
      kolCode: row.KolCode,
      moeenCode: row.MoeenCode,
      tafsiliCode: row.TafsiliCode,
      debit: row.Bed,
      credit: row.Bes,
      comment: row.Comment || '',
    });
  }
  return { rows, documents: [...byNumber.values()] };
}

export const PARSIAN_TRANSFER_LIMITS = Object.freeze({
  pageSize: PAGE_SIZE,
  maxRows: INDEX_CAPACITY,
});
