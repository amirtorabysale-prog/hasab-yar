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

// سرستون‌های لیست حقوق. نام‌ها همان چیزی‌اند که در لیست حقوق دفترها نوشته
// می‌شود؛ «حقوق ناخالص»، «ناخالص» و «جمع حقوق و مزایا» یک چیزند.
const PAYROLL_ALIASES = {
  employeeName: ['name', 'employee', 'نام', 'نامپرسنل', 'نامونامخانوادگی', 'پرسنل', 'کارمند', 'نامکارمند'],
  nationalId: ['nationalid', 'کدملی', 'شمارهملی', 'شناسهملی'],
  gross: ['gross', 'حقوقناخالص', 'ناخالص', 'جمعحقوقومزایا', 'حقوقومزایا', 'ناخالصحقوق', 'جمعناخالص'],
  insuranceEmployee: ['بیمهسهمکارمند', 'بیمهکارمند', 'سهمبیمهکارمند', 'بیمهسهمکارگر', 'کسربیمه'],
  insuranceEmployer: ['بیمهسهمکارفرما', 'بیمهکارفرما', 'سهمبیمهکارفرما'],
  incomeTax: ['tax', 'مالیات', 'مالیاتحقوق', 'کسرمالیات'],
  otherDeductions: ['سایرکسورات', 'کسورات', 'سایرکسور', 'وام', 'مساعده'],
  net: ['net', 'خالص', 'خالصپرداختی', 'قابلپرداخت', 'خالصحقوق'],
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

export const payrollRowsFromFile = (buffer, fileName = '') => rowsFromFile(buffer, fileName, {
  aliases: PAYROLL_ALIASES, required: ['employeeName', 'gross'], label: 'لیست حقوق',
  labels: {
    employeeName: 'نام پرسنل', gross: 'حقوق ناخالص', nationalId: 'کد ملی',
    insuranceEmployee: 'بیمهٔ سهم کارمند', insuranceEmployer: 'بیمهٔ سهم کارفرما',
    incomeTax: 'مالیات', otherDeductions: 'سایر کسورات', net: 'خالص پرداختی',
  },
});

export const openingRowsFromFile = (buffer, fileName = '') => rowsFromFile(buffer, fileName, {
  aliases: OPENING_ALIASES, required: ['code', 'debit', 'credit'], label: 'فایل ماندهٔ افتتاحیه',
  labels: { code: 'کد حساب', debit: 'بدهکار', credit: 'بستانکار', analyticCode: 'کد تفصیلی' },
});
