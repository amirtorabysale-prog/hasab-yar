import { readTabularFile } from './spreadsheet.js';
import { tableFromSheet } from './ledgerImport.js';

const CHART_ALIASES = {
  code: ['code', 'accountcode', 'کد', 'کدحساب', 'کدینگ'],
  name: ['name', 'title', 'accountname', 'نام', 'نامحساب', 'شرح', 'عنوان'],
  level: ['level', 'سطح', 'نوعسطح', 'ردهحساب'],
  parentCode: ['parent', 'parentcode', 'کدوالد', 'والد', 'کدبالاسری', 'حسابوالد'],
  type: ['type', 'accounttype', 'نوع', 'نوعحساب', 'ماهیت'],
  role: ['role', 'نقش', 'کاربرد'],
  levelCode: ['levelcode', 'کدسطح', 'کدمقصدسطح', 'کدپارسیان', 'کدنرمافزار'],
  requiresAnalytic: ['requiresanalytic', 'تفصیلیاجباری', 'تفصیلیدارد', 'دارایتفصیلی', 'شناوراجباری', 'تفصیلی'],
};

const ANALYTIC_ALIASES = {
  code: ['code', 'کد', 'کدتفصیلی', 'کدطرفحساب', 'کدشناور'],
  name: ['name', 'title', 'نام', 'نامتفصیلی', 'شرح', 'عنوان', 'نامطرفحساب'],
  kind: ['kind', 'type', 'نوع', 'گروه', 'نوعتفصیلی'],
  externalCode: ['externalcode', 'destinationcode', 'کدمقصد', 'کدپارسیان', 'کدتفصیلیمقصد', 'کدنرمافزار', 'کدشناورمقصد'],
};

const OPENING_ALIASES = {
  code: ['code', 'accountcode', 'کد', 'کدحساب', 'کدمعین', 'کدینگ'],
  name: ['name', 'accountname', 'نام', 'نامحساب', 'شرححساب', 'عنوان'],
  debit: ['debit', 'بدهکار', 'ماندهبدهکار', 'گردشبدهکار', 'بدهکارریال', 'بدهکارتومان'],
  credit: ['credit', 'بستانکار', 'ماندهبستانکار', 'گردشبستانکار', 'بستانکارریال', 'بستانکارتومان'],
  analyticCode: ['analytic', 'analyticcode', 'کدتفصیلی', 'تفصیلی', 'شناور'],
};

function rowsFromFile(buffer, fileName, schema) {
  const sheet = readTabularFile(buffer, fileName)[0];
  return tableFromSheet(sheet, schema);
}

export const chartRowsFromFile = (buffer, fileName = '') => rowsFromFile(buffer, fileName, {
  aliases: CHART_ALIASES, required: ['code', 'name', 'level', 'type'], label: 'فایل کدینگ',
  labels: { code: 'کد', name: 'نام', level: 'سطح', type: 'نوع', parentCode: 'کد والد', levelCode: 'کد سطح', requiresAnalytic: 'تفصیلی اجباری' },
});

export const analyticRowsFromFile = (buffer, fileName = '') => rowsFromFile(buffer, fileName, {
  aliases: ANALYTIC_ALIASES, required: ['name'], label: 'فایل تفصیلی',
  labels: { code: 'کد', name: 'نام', kind: 'نوع', externalCode: 'کد مقصد' },
});

export const openingRowsFromFile = (buffer, fileName = '') => rowsFromFile(buffer, fileName, {
  aliases: OPENING_ALIASES, required: ['code', 'debit', 'credit'], label: 'فایل ماندهٔ افتتاحیه',
  labels: { code: 'کد حساب', debit: 'بدهکار', credit: 'بستانکار', analyticCode: 'کد تفصیلی' },
});
