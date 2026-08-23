export const PRODUCT_POSITIONING = Object.freeze({
  name: 'حساب‌یار',
  category: 'voice-cashbook',
  shortDescription: 'دفتر مالی صوتی و دستیار مدیریت نقدینگی برای فارسی‌زبان‌ها',
  accountingScope: 'cash-basis-assistant',
  accountingDisclaimer: 'عددهای فعلی بر پایهٔ دریافت و پرداخت‌های ثبت‌شده‌اند و جایگزین صورت‌های مالی یا دفاتر قانونی نیستند.',
});

export const MONEY_POLICY = Object.freeze({
  schemaVersion: 1,
  currentStorageUnit: 'IRT',
  currentDisplayUnit: 'IRT',
  canonicalTargetUnit: 'IRR',
  rialPerToman: 10,
  migrationRequired: true,
  migrationNote: 'داده‌های نسخهٔ ۱ به تومان ذخیره شده‌اند؛ مهاجرت به ریال باید نسخه‌بندی‌شده و بدون تغییر معنای مبالغ موجود انجام شود.',
});

export const PROFILE_DEFINITIONS = Object.freeze({
  personal: Object.freeze({
    id: 'personal',
    label: 'حساب شخصی',
    description: 'برای مدیریت دریافت‌ها، پرداخت‌ها، اقساط، بودجه و پس‌انداز شخصی',
    summaryLabels: Object.freeze({ income: 'دریافتی امروز', expense: 'پرداختی امروز', net: 'خالص امروز' }),
    ledgerTabs: Object.freeze(['transactions', 'obligations', 'recurring', 'tools']),
    capabilities: Object.freeze(['ثبت صوتی و دستی', 'دریافت و پرداخت', 'قسط و بدهی', 'ثبت‌های دوره‌ای', 'رسیدهای مالی']),
    plannedCapabilities: Object.freeze(['حساب‌ها و کیف پول‌ها', 'بودجه', 'پس‌انداز']),
  }),
  business: Object.freeze({
    id: 'business',
    label: 'کسب‌وکار کوچک',
    description: 'برای مدیریت نقدینگی، مشتریان، سررسیدها، فاکتور و موجودی سبک',
    summaryLabels: Object.freeze({ income: 'فروش و دریافت امروز', expense: 'هزینه امروز', net: 'خالص جریان نقدی' }),
    ledgerTabs: Object.freeze(['transactions', 'obligations', 'invoices', 'recurring', 'inventory', 'accounting', 'tools']),
    capabilities: Object.freeze(['ثبت صوتی و دستی', 'فروش و هزینه', 'مشتری و تأمین‌کننده', 'فاکتور فروش و خرید', 'تسویه مرحله‌ای', 'موجودی سبک', 'دفتر کل دوطرفه', 'بستن صندوق']),
    plannedCapabilities: Object.freeze(['تطبیق بانکی', 'مالیات و ارزش افزوده']),
  }),
});

export function profileDefinition(profileType) {
  return PROFILE_DEFINITIONS[profileType] || PROFILE_DEFINITIONS.business;
}
