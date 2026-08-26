const DAY_MS = 24 * 60 * 60 * 1000;

export const PLAN_CATALOG = Object.freeze({
  free: Object.freeze({
    id: 'free', label: 'رایگان', description: 'برای شروع ثبت روزانه و سنجش عادت استفاده',
    limits: Object.freeze({ smartVoiceRequests: 30, receiptOcrPages: 10, members: 2 }),
  }),
  professional: Object.freeze({
    id: 'professional', label: 'حرفه‌ای', description: 'برای یک کسب‌وکار با ثبت و بازبینی منظم',
    limits: Object.freeze({ smartVoiceRequests: 600, receiptOcrPages: 200, members: 5 }),
  }),
  accountant: Object.freeze({
    id: 'accountant', label: 'همکاری حسابدار', description: 'برای دفتر حسابداری و چند همکار روی دفتر مشتری',
    limits: Object.freeze({ smartVoiceRequests: 3_000, receiptOcrPages: 1_000, members: 50 }),
  }),
});

export function normalizePlanId(value) {
  return Object.hasOwn(PLAN_CATALOG, value) ? value : 'free';
}

export function billingMonth(value = '', now = new Date()) {
  const requested = String(value || '').trim();
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(requested) ? requested : now.toISOString().slice(0, 7);
  const [year, monthNumber] = month.split('-').map(Number);
  const from = new Date(Date.UTC(year, monthNumber - 1, 1));
  const toExclusive = new Date(Date.UTC(year, monthNumber, 1));
  return { month, from: from.toISOString(), toExclusive: toExclusive.toISOString(), to: new Date(toExclusive.getTime() - 1).toISOString() };
}

export function usageQuotaSnapshot(planId, usage = {}) {
  const plan = PLAN_CATALOG[normalizePlanId(planId)];
  const item = (id, label, used, limit, note = '') => {
    const normalizedUsed = Math.max(0, Number(used) || 0);
    const normalizedLimit = Math.max(0, Number(limit) || 0);
    return {
      id, label, used: normalizedUsed, limit: normalizedLimit,
      remaining: Math.max(0, normalizedLimit - normalizedUsed),
      percent: normalizedLimit ? Math.min(100, Math.round((normalizedUsed / normalizedLimit) * 100)) : 0,
      exhausted: normalizedLimit > 0 && normalizedUsed >= normalizedLimit,
      note,
    };
  };
  return [
    item('smartVoiceRequests', 'پردازش صوت هوشمند', usage.smartVoiceRequests, plan.limits.smartVoiceRequests, 'تایپ Chrome و ورود دستی همیشه بدون این سهمیه فعال می‌ماند.'),
    item('receiptOcrPages', 'خواندن هوشمند رسید', usage.receiptOcrPages, plan.limits.receiptOcrPages, 'رسید پس از پایان سهمیه همچنان ذخیره و دستی بازبینی می‌شود.'),
    item('members', 'اعضای دفتر', usage.members, plan.limits.members),
  ];
}

function nonNegativeRate(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

export function providerRateCard(env = process.env) {
  return {
    openaiAudioMinute: nonNegativeRate(env.OPENAI_TRANSCRIBE_USD_PER_MINUTE),
    openaiRealtimeMinute: nonNegativeRate(env.OPENAI_REALTIME_USD_PER_MINUTE),
    geminiAudioMinute: nonNegativeRate(env.GEMINI_AUDIO_USD_PER_MINUTE),
    openaiReceiptImage: nonNegativeRate(env.OPENAI_OCR_USD_PER_IMAGE),
  };
}

export function estimateProviderCostMicrousd({ capability, provider, durationMs = 0, requestCount = 1 } = {}, env = process.env) {
  const rates = providerRateCard(env);
  let dollars = null;
  if (capability === 'receipt_ocr' && provider === 'openai') dollars = rates.openaiReceiptImage == null ? null : rates.openaiReceiptImage * Math.max(0, Number(requestCount) || 0);
  if (capability === 'server_voice' && provider === 'openai') dollars = rates.openaiAudioMinute == null ? null : rates.openaiAudioMinute * (Math.max(0, Number(durationMs) || 0) / 60_000);
  if (capability === 'server_voice' && provider === 'gemini') dollars = rates.geminiAudioMinute == null ? null : rates.geminiAudioMinute * (Math.max(0, Number(durationMs) || 0) / 60_000);
  if (capability === 'realtime_duration' && provider === 'openai') dollars = rates.openaiRealtimeMinute == null ? null : rates.openaiRealtimeMinute * (Math.max(0, Number(durationMs) || 0) / 60_000);
  return dollars == null ? null : Math.max(0, Math.round(dollars * 1_000_000));
}

export function audioDurationMs(buffer, mimeType = '') {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44 || !/audio\/(wav|wave|x-wav)/i.test(mimeType)) return 0;
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') return 0;
  const byteRate = buffer.readUInt32LE(28);
  const dataBytes = buffer.readUInt32LE(40);
  if (!byteRate || !dataBytes) return 0;
  return Math.max(0, Math.round((dataBytes / byteRate) * 1000));
}

export function quotaError(item) {
  return Object.assign(new Error(`${item.label} این ماه به سقف پلن رسیده است. ${item.note || 'پیش از مصرف دوباره، پلن یا سهمیه را بررسی کن.'}`), {
    status: 402,
    code: 'PLAN_QUOTA_EXCEEDED',
    details: { quota: item },
  });
}

export function monthlyPackageChecklist(sections = {}) {
  const checks = [
    { id: 'receipts', label: 'رسید ناقص باقی نمانده', count: sections.incompleteReceipts?.length || 0 },
    { id: 'closings', label: 'اختلاف صندوق توضیح‌نداده باقی نمانده', count: sections.closingDiscrepancies?.length || 0 },
    { id: 'reconciliation', label: 'تطبیق بانکی باز باقی نمانده', count: sections.reconciliationIssues?.length || 0 },
    { id: 'requests', label: 'درخواست توضیح بی‌پاسخ باقی نمانده', count: sections.openRequests?.filter((item) => item.status === 'open').length || 0 },
  ].map((check) => ({ ...check, passed: check.count === 0 }));
  return { ready: checks.every((item) => item.passed), checks };
}

export function pilotRetentionSummary(workspaces = []) {
  const eligible = workspaces.filter((item) => item.eligibleForWeekFour);
  const active = eligible.filter((item) => item.weekFourActive);
  const paying = workspaces.filter((item) => item.willingnessToPay === 'yes');
  return {
    workspaceCount: workspaces.length,
    eligibleWeekFour: eligible.length,
    weekFourActive: active.length,
    retentionPercent: eligible.length ? Math.round((active.length / eligible.length) * 100) : null,
    willingToPay: paying.length,
    willingnessPercent: workspaces.length ? Math.round((paying.length / workspaces.length) * 100) : null,
    retentionTargetPercent: 40,
    willingnessTargetPercent: 30,
  };
}

export function fourWeekWindows(now = new Date()) {
  const end = new Date(now);
  const windows = [];
  for (let index = 0; index < 4; index += 1) {
    const toExclusive = new Date(end.getTime() - index * 7 * DAY_MS);
    const from = new Date(toExclusive.getTime() - 7 * DAY_MS);
    windows.unshift({ index: 4 - index, from: from.toISOString(), toExclusive: toExclusive.toISOString() });
  }
  return windows;
}
