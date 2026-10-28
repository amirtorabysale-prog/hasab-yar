// سازندهٔ بکاپ سینتتیک پارسیان با ساختار واقعی SQL Server 2000.
//
// هر چهار چیزی که بکاپ واقعی دارد و خواننده باید از پسش بربیاید اینجا ساخته
// می‌شود: صفحه‌های نامرتب با فاصله (فقط extentهای تخصیص‌یافته)، torn bits در
// انتهای هر بخش ۵۱۲تایی، صفحهٔ کهنهٔ تخصیص‌نیافته در PFS با ردیف‌های قدیمی، و
// بایت‌های ردیف حذف‌شده‌ای که آرایهٔ slot به آن اشاره نمی‌کند.

const PAGE_SIZE = 8192;
const TYPES = { tinyint: 48, smallint: 52, int: 56, float: 62, nvarchar: 231, decimal: 106, bit: 104 };
// decimal(18,2): یک بایت علامت و هشت بایت عدد. bitها یک بایت را با جای بیت خود شریک‌اند.
const SIZES = { tinyint: 1, smallint: 2, int: 4, float: 8, decimal: 9, bit: 1 };

// چیدمان ستون‌ها همان ترتیب و آفستی است که در بکاپ واقعی پارسیان دیده شد.
export const PARSIAN_TABLES = {
  tbl_ACCGroup: [['Code', 'smallint'], ['CName', 'nvarchar']],
  tbl_Kol: [['Code', 'smallint'], ['CName', 'nvarchar'], ['GroupCode', 'smallint'], ['iType', 'tinyint']],
  tbl_Moeen: [['KolCode', 'smallint'], ['Code', 'smallint'], ['CName', 'nvarchar'], ['FirstRemain', 'float']],
  tbl_Tafsili: [['KolCode', 'smallint'], ['MoeenCode', 'smallint'], ['Code', 'int'], ['CName', 'nvarchar']],
  tbl_Document: [
    ['ID', 'int'], ['Sanad_Num', 'int'], ['SanadDate', 'nvarchar'], ['KolCode', 'smallint'], ['MoeenCode', 'smallint'],
    ['TafsiliCode', 'int'], ['Comment', 'nvarchar'], ['Bed', 'float'], ['Bes', 'float'], ['SanadComment', 'nvarchar'], ['Factor_Num', 'int'],
  ],
  // حساب‌هایی که پارسیان برای هر کار تعیین کرده؛ کل و معین smallint، تفصیلی int.
  tbl_AccSetting: [['ID', 'int'], ...['Cash', 'Sell', 'Wage', 'Asset'].flatMap((key) => [[`${key}_K`, 'smallint'], [`${key}_M`, 'smallint'], [`${key}_T`, 'int']])],
  tbl_VATSetting: [['ID', 'int'], ...['VATSale', 'VATBuy'].flatMap((key) => [[`${key}_K`, 'int'], [`${key}_M`, 'int'], [`${key}_T`, 'int']])],
  // اطلاعات پایه بیرون از اسناد، با همان نوع ستون‌های بکاپ واقعی (کد کالا float، تعداد decimal، بیت مشترک).
  tbl_GoodsGroup: [['Code', 'smallint'], ['CName', 'nvarchar'], ['IsService', 'bit']],
  tbl_Goods: [['Code', 'float'], ['GroupCode', 'smallint'], ['CName', 'nvarchar'], ['UnitName_1', 'nvarchar'], ['Equal', 'decimal'], ['Price_1', 'float'], ['VATPercent', 'decimal'], ['HaveChild', 'bit'], ['IsActive', 'bit']],
  tbl_Telephone: [['ID', 'int'], ['KolCode', 'smallint'], ['MoeenCode', 'smallint'], ['TafsiliCode', 'int'], ['CName', 'nvarchar'], ['Tel', 'nvarchar'],
    ['Mobile', 'nvarchar'], ['Address', 'nvarchar'], ['CodeEco', 'nvarchar'], ['CodeNat', 'nvarchar'], ['CodePost', 'nvarchar']],
  tbl_FactorKind: [['Code', 'smallint'], ['CName', 'nvarchar'], ['HaveDocument', 'bit']],
  tbl_Factor: [['ID', 'int'], ['Factor_Num', 'int'], ['Factor_Date', 'nvarchar'], ['TitleCode', 'smallint'], ['Number', 'decimal'], ['Sanad_Num', 'int'], ['GoodsCode', 'float'],
    ['Tedad', 'decimal'], ['Price', 'float'], ['Discont', 'float'], ['GoodsComment', 'nvarchar'], ['FactorComment', 'nvarchar'], ['ConsumFkCode', 'int']],
  tbl_SubGoods: [['MainGoodsCode', 'float'], ['SubGoodsCode', 'float'], ['Number', 'decimal'], ['Price', 'float'], ['NumTolid', 'decimal']],
  // چک، با همان نوع و ترتیب ستون‌های بکاپ اتیه سازان (۴ بیت در یک بایت مشترک).
  tbl_Check: [['ID', 'int'], ['Chk_Num', 'int'], ['Sanad_Num', 'int'], ['Sanad_Num_VosolPas', 'int'], ['ExpDate', 'nvarchar'], ['RecDate', 'nvarchar'],
    ['Giv_Date', 'nvarchar'], ['Money', 'float'], ['Bank_K', 'smallint'], ['Bank_M', 'smallint'], ['Bank_T', 'int'], ['Acc_K', 'smallint'], ['Acc_M', 'smallint'],
    ['Acc_T', 'int'], ['Taraf_K', 'smallint'], ['Taraf_M', 'smallint'], ['Taraf_T', 'int'], ['Chk_Kind', 'smallint'], ['Comment', 'nvarchar'], ['Bank', 'nvarchar'],
    ['Vos_Pas', 'smallint'], ['IsActive', 'bit'], ['Tick', 'bit'], ['Lashe', 'bit'], ['IsREG', 'bit'], ['Sayad', 'nvarchar']],
  tbl_RecycleCheck: [['ID', 'int'], ['CHK_ID', 'int'], ['ExpDate', 'nvarchar'], ['Giv_Date', 'nvarchar'], ['Acc_K', 'smallint'], ['Acc_M', 'smallint'],
    ['Acc_T', 'int'], ['Sanad_Num', 'int'], ['Vos_Pas', 'smallint'], ['IsActive', 'bit']],
  // سطل بازیافت، یک جدول مالیِ خوانده‌نشده و یک جدول کمکی: هشدار پیش‌نمایش.
  tbl_RecycleBinDoc: [['ID', 'int'], ['Sanad_Num', 'int'], ['Bed', 'float']],
  tbl_Ghest: [['ID', 'int'], ['Money', 'float']],
  tbl_Hafez: [['ID', 'int'], ['Text', 'nvarchar']],
  tbl_CoSpec: [['ID', 'int'], ['ECOcode', 'nvarchar'], ['PostalCode', 'nvarchar'], ['Code', 'nvarchar'], ['Address', 'nvarchar'], ['Tel', 'nvarchar'], ['Estate', 'nvarchar'], ['City', 'nvarchar']],
  // رازی که خواننده هرگز نباید بخواند (کلید سامانهٔ مؤدیان در بکاپ واقعی همین‌جاست).
  tbl_NEWMovadianInfo: [['ID', 'int'], ['PrivateKey', 'nvarchar'], ['Token', 'nvarchar']],
};

function layout(columns) {
  let fixed = 4;
  let variable = 0;
  let bitByte = null;
  let bitCount = 0;
  return columns.map(([name, type], index) => {
    const column = { name, type, xtype: TYPES[type], colid: index + 1 };
    if (type === 'nvarchar') { variable += 1; return { ...column, length: 400, xoffset: -variable }; }
    if (type === 'bit') {
      if (bitByte === null || bitCount === 8) { bitByte = fixed; fixed += 1; bitCount = 0; }
      return { ...column, length: 1, xoffset: bitByte, bitpos: bitCount++ };
    }
    const result = { ...column, length: SIZES[type], xoffset: fixed, ...(type === 'decimal' ? { xprec: 18, xscale: 2 } : {}) };
    fixed += SIZES[type];
    return result;
  });
}

/** یک ردیف SQL Server 2000 با بیت‌نقشهٔ تهی و ستون‌های متغیر. */
export function encodeRecord(columns, values) {
  const fixedColumns = columns.filter((column) => column.xoffset > 0);
  const fixedEnd = fixedColumns.reduce((end, column) => Math.max(end, column.xoffset + column.length), 4);
  const head = Buffer.alloc(fixedEnd);
  head[0] = 0x30;
  head.writeUInt16LE(fixedEnd, 2);
  const bitmap = Buffer.alloc(Math.ceil(columns.length / 8));
  for (const column of columns) {
    const value = values[column.name];
    if (value == null) { bitmap[(column.colid - 1) >> 3] |= 1 << ((column.colid - 1) & 7); continue; }
    if (column.xoffset < 0) continue;
    if (column.type === 'tinyint') head[column.xoffset] = value;
    if (column.type === 'smallint') head.writeInt16LE(value, column.xoffset);
    if (column.type === 'int') head.writeInt32LE(value, column.xoffset);
    if (column.type === 'float') head.writeDoubleLE(value, column.xoffset);
    if (column.type === 'bit' && value) head[column.xoffset] |= 1 << column.bitpos;
    if (column.type === 'decimal') {
      head[column.xoffset] = value < 0 ? 0 : 1;
      head.writeBigUInt64LE(BigInt(Math.round(Math.abs(value) * 10 ** column.xscale)), column.xoffset + 1);
    }
  }
  const variableColumns = columns.filter((column) => column.xoffset < 0).sort((first, second) => second.xoffset - first.xoffset);
  const texts = variableColumns.map((column) => Buffer.from(values[column.name] ?? '', 'utf16le'));
  const count = Buffer.alloc(2); count.writeUInt16LE(columns.length);
  const varCount = Buffer.alloc(2); varCount.writeUInt16LE(texts.length);
  const ends = Buffer.alloc(2 * texts.length);
  let end = fixedEnd + 2 + bitmap.length + 2 + ends.length;
  texts.forEach((text, index) => { end += text.length; ends.writeUInt16LE(end, 2 * index); });
  return Buffer.concat([head, count, bitmap, varCount, ends, ...texts]);
}

function emptyPage({ pageId, type, objectId }) {
  const page = Buffer.alloc(PAGE_SIZE);
  page[0] = 1; page[1] = type;
  page.writeUInt16LE(0x100, 4); // torn page detection روشن
  page.writeUInt32LE(objectId, 24);
  page.writeUInt32LE(pageId, 32);
  page.writeUInt16LE(1, 36);
  return page;
}

/** صفحه‌های داده: ردیف‌ها پشت هم، هر چند ردیف یک ردیف حذف‌شده لای آن‌ها. */
function dataPages(objectId, records, nextPageId, { deleted = [] } = {}) {
  const pages = [];
  let page = null;
  let offset = 0;
  let slots = [];
  const close = () => {
    if (!page) return;
    slots.forEach((slotOffset, index) => page.writeUInt16LE(slotOffset, PAGE_SIZE - 2 - 2 * index));
    page.writeUInt16LE(slots.length, 22);
    page.writeUInt16LE(offset, 30);
    pages.push(page);
    page = null;
  };
  const queue = [...records];
  let deletedIndex = 0;
  while (queue.length) {
    const ghost = deleted[deletedIndex];
    const record = ghost && queue.length % 3 === 0 ? ghost : queue[0];
    if (!page) { page = emptyPage({ pageId: nextPageId(), type: 1, objectId }); offset = 96; slots = []; }
    if (offset + record.length > PAGE_SIZE - 2 * (slots.length + 2)) { close(); continue; }
    record.copy(page, offset);
    if (record === ghost) deletedIndex += 1; // بایت‌ها می‌مانند، slot نه
    else { slots.push(offset); queue.shift(); }
    offset += record.length;
  }
  close();
  return pages;
}

function applyTornBits(page, pattern) {
  let torn = pattern & 3;
  for (let sector = 1; sector < 16; sector += 1) {
    const at = 512 * (sector + 1) - 1;
    torn |= (page[at] & 3) << (2 * sector);
    page[at] = (page[at] & 0xfc) | (pattern & 3);
  }
  page.writeUInt32LE(torn >>> 0, 60);
}

/**
 * tables: { tbl_Kol: [{Code, CName, ...}], ... }
 * stale: ردیف‌های کهنهٔ tbl_Document که در صفحهٔ تخصیص‌نیافته می‌مانند.
 * deleted: ردیف‌های حذف‌شدهٔ tbl_Document که بایتشان لای صفحه‌های زنده است.
 */
export function buildParsianBackup(tables, { stale = [], deleted = [], seed = 1, pageOrder = 'shuffled' } = {}) {
  let pageId = 16;
  const nextPageId = () => pageId++;
  const objectIds = {};
  const sysobjects = [];
  const syscolumns = [];
  const objectColumns = layout([['id', 'int'], ['xtype', 'smallint'], ['name', 'nvarchar']]);
  const columnColumns = layout([
    ['id', 'int'], ['xtype', 'tinyint'], ['typestat', 'tinyint'], ['xusertype', 'smallint'], ['length', 'smallint'],
    ['xprec', 'tinyint'], ['xscale', 'tinyint'], ['colid', 'smallint'], ['xoffset', 'smallint'], ['bitpos', 'tinyint'], ['name', 'nvarchar'],
  ]);
  const allocated = new Set();
  const pages = [];
  Object.entries(PARSIAN_TABLES).forEach(([name, definition], index) => {
    const objectId = 100000 + index * 7919;
    objectIds[name] = objectId;
    const columns = layout(definition);
    const sysobject = encodeRecord(objectColumns, { id: objectId, xtype: 0, name });
    sysobject.write('U ', 8, 'latin1');
    sysobjects.push(sysobject);
    for (const column of columns) {
      syscolumns.push(encodeRecord(columnColumns, {
        id: objectId, xtype: column.xtype, typestat: 0, xusertype: column.xtype, length: column.length,
        xprec: column.xprec || 0, xscale: column.xscale || 0, colid: column.colid, xoffset: column.xoffset, bitpos: column.bitpos || 0, name: column.name,
      }));
    }
    const records = (tables[name] || []).map((row) => encodeRecord(columns, row));
    const ghosts = name === 'tbl_Document' ? deleted.map((row) => encodeRecord(columns, row)) : [];
    for (const page of dataPages(objectId, records, nextPageId, { deleted: ghosts })) { pages.push(page); allocated.add(page.readUInt32LE(32)); }
    if (name === 'tbl_Document' && stale.length) {
      for (const page of dataPages(objectId, stale.map((row) => encodeRecord(columns, row)), nextPageId)) pages.push(page);
    }
  });
  for (const page of dataPages(1, sysobjects, nextPageId)) { pages.push(page); allocated.add(page.readUInt32LE(32)); }
  for (const page of dataPages(3, syscolumns, nextPageId)) { pages.push(page); allocated.add(page.readUInt32LE(32)); }

  const pfs = emptyPage({ pageId: 1, type: 11, objectId: 99 });
  const body = Buffer.alloc(8092);
  body.writeUInt16LE(0x1f9c, 2);
  for (const id of [0, 1, ...allocated]) body[4 + id] = 0x40;
  body.copy(pfs, 96);
  pfs.writeUInt16LE(96, PAGE_SIZE - 2);
  pfs.writeUInt16LE(1, 22);
  pfs.writeUInt16LE(96 + body.length, 30);
  pages.push(pfs);

  let state = seed >>> 0 || 1;
  const random = () => { state = (state * 1103515245 + 12345) >>> 0; return state / 2 ** 32; };
  for (const page of pages) applyTornBits(page, random() < 0.5 ? 1 : 2);
  if (pageOrder === 'shuffled') {
    for (let index = pages.length - 1; index > 0; index -= 1) {
      const other = Math.floor(random() * (index + 1));
      [pages[index], pages[other]] = [pages[other], pages[index]];
    }
  }
  const parts = [Buffer.concat([Buffer.from('TAPE', 'ascii'), Buffer.alloc(6656 - 4)])];
  for (const page of pages) {
    parts.push(page);
    if (random() < 0.3) parts.push(Buffer.alloc(512 * (1 + Math.floor(random() * 4))));
  }
  return Buffer.concat(parts);
}
