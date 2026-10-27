import { needsUnquantifiedReview, UNQUANTIFIED_REVIEW_REASON } from '../shared/reviewIntake.js';
import { averagesInToman, draftInLedgerUnit, parseResultInLedgerUnit } from '../shared/amountUnit.js';
import { Check, Menu, RotateCcw, WifiOff } from 'lucide-react';
import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import { BottomNav, DesktopNav, Drawer, allowedScreens } from './app/navigation.jsx';
import { ThemeChoice, ThemeToggle } from './components/ThemeToggle.jsx';
import { writeRoute } from './app/route.js';
import { CARD_SECTIONS, LEDGER_SECTIONS, SETTINGS_REQUIRES, SETTINGS_SECTIONS, findMenuItem, visibleMenu } from './app/menu.js';
import { profileDefinition } from '../shared/product.js';
import { CloseDaySheet, TodayPage } from './features/today/TodayPage.jsx';
import { ConfirmationSheet, CorrectionSheet, DecisionDetailsSheet, DuplicateSheet, FailureSheet, LearningSuggestionSheet, PossibleDuplicateSheet } from './features/capture/CaptureSheets.jsx';
import CounterpartyMatchSheet from './features/counterparty/CounterpartyMatchSheet.jsx';
import { EMPTY_SUMMARY } from './components/common.jsx';
import { IntentSheet, SettleSheet } from './features/capture/IntentSheets.jsx';
import { inUnderstandingScope } from '../shared/understandingScope.js';
import { LoginPage, Onboarding } from './features/auth/AuthScreens.jsx';
import { api, queueTransactions, setDuplicateConfirmer, setOverdraftApprover } from './lib/api.js';
import { OverdraftApprovalSheet } from './features/capture/OverdraftApprovalSheet.jsx';
import { applyDnaSignals } from '../shared/dnaSignals.js';
import { mascotAlert, mascotMood } from './lib/mascotMood.js';
import { detectVoiceIntent } from '../shared/voiceIntent.js';
import { countOfflineAudio, releaseOfflineAudio, removeOfflineAudio } from './lib/offlineAudio.js';
import { detectSettleIntent } from '../shared/settleSpeech.js';
import { detectPartnerPaidDebt } from '../shared/partnerPaidSpeech.js';
import { COMPOSITE_AMOUNT_MESSAGE, hasCompositeAmounts, inferLearningKeyword, parseFinancialText } from '../shared/parser.js';
import { isCorrectionCommand, previewCorrection } from '../shared/correction.js';
import { detectCaptureTransfer, detectPettyCashFunding } from '../shared/bankSpeech.js';
import { setLedgerAmountUnit, toPersianDigits, unitLabel } from './lib/format.js';
import { useScreenNavigation } from './app/useScreenNavigation.js';
import { useIntentDrafts } from './app/useIntentDrafts.js';
import { useOfflineAudioSync } from './app/useOfflineAudioSync.js';
import { useVoiceCapture } from './app/useVoiceCapture.js';
import { aiForAllState } from './lib/aiForAll.js';

/**
 * صفحه‌ای که پشت ناوبری است با اولین باز شدن خودش می‌آید، نه با اولین باز
 * شدن برنامه.
 *
 * تا امروز هر چهارده صفحه در بستهٔ اول بودند. یعنی کسی که فقط «امروز» را باز
 * می‌کرد، کدینگ و انتقال پارسیان و حقوق و مالیات را هم دانلود می‌کرد — روی
 * پیوندی که هر درخواستش ثانیه‌ها طول می‌کشد.
 *
 * اندازه‌گیری روی source map نشان داد از ۶۲۶ کیلوبایت کد خودمان، همین
 * صفحه‌های گیت‌شده حدود ۲۸۰ کیلوبایت‌اند: دفتر ۸۸، همکاری حسابدار ۶۳،
 * حسابداری ۳۹، تنظیمات ۲۷، کدینگ ۲۳ و مالیات ۱۹.
 *
 * «امروز» عمداً بیرون از این فهرست است: صفحهٔ فرود است و تنبل‌کردنش فقط یک
 * رفت‌وبرگشت به مسیر اصلی اضافه می‌کند. برگه‌های ثبت صوتی هم همین‌طور، چون
 * کار اصلی کاربر روی همان صفحه انجام می‌شود.
 */
const namedLazy = (load, name) => lazy(() => load().then((module) => ({ default: module[name] })));

const AccountingPage = namedLazy(() => import('./features/accounting/AccountingPage.jsx'), 'AccountingPage');
const AccountsPanel = namedLazy(() => import('./features/settings/SettingsPage.jsx'), 'AccountsPanel');
const BackupPanel = namedLazy(() => import('./features/settings/SettingsPage.jsx'), 'BackupPanel');
const ChartPage = namedLazy(() => import('./features/chart/ChartPage.jsx'), 'ChartPage');
const CollaborationPage = namedLazy(() => import('./features/collaboration/CollaborationPage.jsx'), 'CollaborationPage');
const DataPrivacyPanel = namedLazy(() => import('./features/settings/SettingsPage.jsx'), 'DataPrivacyPanel');
const ExportAccessCard = lazy(() => import('./features/settings/ExportAccessCard.jsx'));
const FirmConsolePage = namedLazy(() => import('./features/firm/FirmConsolePage.jsx'), 'FirmConsolePage');
const LearningPage = namedLazy(() => import('./features/learning/LearningPage.jsx'), 'LearningPage');
const DnaPage = namedLazy(() => import('./features/dna/DnaPage.jsx'), 'DnaPage');
const LedgerPage = namedLazy(() => import('./features/ledger/LedgerPage.jsx'), 'LedgerPage');
const LogoutPanel = namedLazy(() => import('./features/settings/SettingsPage.jsx'), 'LogoutPanel');
const PasswordPanel = namedLazy(() => import('./features/settings/SettingsPage.jsx'), 'PasswordPanel');
const ReportPage = namedLazy(() => import('./features/reports/ReportPage.jsx'), 'ReportPage');
const AccountingReportsPage = namedLazy(() => import('./features/reports/AccountingReportsPage.jsx'), 'AccountingReportsPage');
const ReviewQueuePage = namedLazy(() => import('./features/review/ReviewQueuePage.jsx'), 'ReviewQueuePage');
const SessionsPanel = namedLazy(() => import('./features/settings/SettingsPage.jsx'), 'SessionsPanel');
const SettingsPage = namedLazy(() => import('./features/settings/SettingsPage.jsx'), 'SettingsPage');
const TaxPage = namedLazy(() => import('./features/tax/TaxPage.jsx'), 'TaxPage');
const PettyCashPage = namedLazy(() => import('./features/pettyCash/PettyCashPage.jsx'), 'PettyCashPage');
// فقط وقتی فهم گفته در دفتر فعال است و گفته‌ای مرکب آمده بارگذاری می‌شود.
const UnderstandingSheet = namedLazy(() => import('./features/understanding/UnderstandingSheet.jsx'), 'UnderstandingSheet');
const WorkspacePanel = lazy(() => import('./features/settings/WorkspacePanel.jsx'));

/** تا رسیدن قطعهٔ صفحه، همان چرخندهٔ آشنای برنامه — نه یک پرش به سفیدی. */
function ScreenLoading() {
  return (
    <div className="grid min-h-[60vh] place-items-center" role="status" aria-label="در حال باز شدن صفحه">
      <span className="h-8 w-8 animate-spin rounded-full border-2 border-line border-t-accent" />
    </div>
  );
}

function useOnlineStatus() {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => { window.removeEventListener('online', up); window.removeEventListener('offline', down); };
  }, []);
  return online;
}

/**
 * دسترسی کامل از پاسخ سرور.
 *
 * سرور در ورود، وضعیت نشست و فهرست دفترها همیشه `screens` و `experience` را
 * هم می‌فرستد. پیش از این چهار جا فقط سه فیلد را برمی‌داشتند و بقیه را دور
 * می‌ریختند؛ نتیجه‌اش این بود که پس از ورود یا تغییر نقش، ناوبری از روی
 * فهرست خالی ساخته می‌شد و صفحه‌هایی مثل «همکاری حسابدار» — که خروجی پارسیان
 * آنجاست — تا بارگذاری کامل بعدی دیده نمی‌شدند.
 */
function accessFromPayload(result = {}) {
  return {
    user: result.user || null,
    workspaces: result.workspaces || [],
    workspace: result.workspace || null,
    experience: result.experience || result.workspace?.experience || 'simple',
    screens: Array.isArray(result.screens) ? result.screens : [],
  };
}

export default function App() {
  const online = useOnlineStatus();
  const [authenticated, setAuthenticated] = useState(null);
  const [authError, setAuthError] = useState('');
  const [access, setAccess] = useState({ user: null, workspaces: [], workspace: null });
  const { screen, section, setSection, drawer, setDrawer, menuSearchRef, navigate } = useScreenNavigation(access);
  const [data, setData] = useState({ transactions: [], summary: EMPTY_SUMMARY, categories: [], accounts: [], settings: {}, learnings: [], averages: {}, dnaProfiles: null, overview: {}, contacts: [], obligations: [], recurring: [], closings: [], closingPreview: null });
  // برچسب مبلغ (تومان یا ریال) و تبدیل گفتار در همهٔ صفحه‌ها از واحد همین دفتر؛ در
  // همین رندر گذاشته می‌شود تا اولین نمایش هم برچسب درست داشته باشد.
  setLedgerAmountUnit(data.settings.amountUnit);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState('');
  const [manualText, setManualText] = useState('');
  const [parseResult, setParseResult] = useState(null);
  const [failure, setFailure] = useState(null);
  const [pendingAudioCount, setPendingAudioCount] = useState(0);
  const [closeDayOpen, setCloseDayOpen] = useState(false);
  const [undoSave, setUndoSave] = useState(null);
  const [redoSave, setRedoSave] = useState(null);
  const [undoing, setUndoing] = useState(false);
  const [correctionDraft, setCorrectionDraft] = useState(null);
  const [duplicatePrompt, setDuplicatePrompt] = useState(null);
  const [learningSuggestion, setLearningSuggestion] = useState(null);
  const [selectedDecision, setSelectedDecision] = useState(null);
  const [voiceSystemStatus, setVoiceSystemStatus] = useState(null);
  const [understandingDraft, setUnderstandingDraft] = useState(null);
  const [aiToggleBusy, setAiToggleBusy] = useState(false);
  // برگهٔ تأیید حسابدار برای منفی شدن موجودی؛ هر درخواستی که سرور برگرداند منتظر جوابش می‌ماند.
  const [overdraftPrompt, setOverdraftPrompt] = useState(null);
  useEffect(() => {
    setOverdraftApprover((info) => new Promise((resolve) => setOverdraftPrompt({ ...info, resolve })));
    return () => setOverdraftApprover(null);
  }, []);
  // برگهٔ «شاید تکراری» برای کارت AI و تأیید صف؛ ثبت روزانه برگهٔ خودش را دارد.
  const [possibleDuplicate, setPossibleDuplicate] = useState(null);
  useEffect(() => {
    setDuplicateConfirmer((info) => new Promise((resolve) => setPossibleDuplicate({ ...info, resolve })));
    return () => setDuplicateConfirmer(null);
  }, []);
  // startRecording یک closure است و مقدار state در آن کهنه می‌ماند؛ تصمیمِ
  // «نشست Realtime باز شود یا نه» باید تازه‌ترین وضعیت سرور را ببیند.
  const voiceSystemStatusRef = useRef(null);
  const rememberedOfflineScope = api.offlineScope();
  const offlineUserId = access.user?.id || rememberedOfflineScope?.userId || '';
  const offlineWorkspaceId = access.workspace?.id || rememberedOfflineScope?.workspaceId || '';
  const offlineScopeReady = Boolean(offlineUserId && offlineWorkspaceId);
  const activeOfflineScope = () => ({ userId: offlineUserId, workspaceId: offlineWorkspaceId });

  const notify = useCallback((message) => {
    setToast(message);
    window.setTimeout(() => setToast(''), 3200);
  }, []);

  const refreshVoiceSystemStatus = useCallback(async () => {
    try {
      const status = await api.voiceStatus();
      voiceSystemStatusRef.current = status;
      setVoiceSystemStatus(status);
      return status;
    } catch { return null; }
  }, []);

  /**
   * دفتر اول می‌آید، تحلیل‌ها بعدش.
   *
   * `financialOverview` و `dnaProfiles` روی سرور ۹۹٪ زمان `bootstrap` را
   * می‌گرفتند و با بزرگ‌شدن دفتر بدتر می‌شوند. حالا در درخواست دوم می‌آیند و
   * تا رسیدنشان همان مقدار قبلی روی صفحه می‌ماند — نه یک پرش به حالت خالی.
   *
   * نتیجهٔ دیررس اگر دفتر عوض شده باشد دور ریخته می‌شود؛ وگرنه هشدار مالی یک
   * دفتر می‌توانست روی دفتر دیگری بنشیند.
   */
  const load = useCallback(async () => {
    try {
      const [bootstrap] = await Promise.all([api.bootstrap(), refreshVoiceSystemStatus()]);
      setData((previous) => ({ ...previous, ...bootstrap, learnings: bootstrap.learnings || [], averages: bootstrap.averages || {} }));
      if (bootstrap.access) setAccess(bootstrap.access);
      // دفتر فعال بعد از پاسخ خوانده می‌شود، نه قبلش: در اولین بارگذاری هنوز
      // چیزی در حافظهٔ محلی نیست و پاسخ خودِ سرور آن را می‌نشاند. خواندن زودتر
      // یعنی مقایسهٔ پایین همیشه شکست بخورد و تحلیلِ درست دور ریخته شود.
      const loadedWorkspace = api.activeWorkspaceId();
      api.insights()
        .then((insights) => setData((previous) => (
          api.activeWorkspaceId() === loadedWorkspace ? { ...previous, ...insights } : previous
        )))
        .catch(() => { /* تحلیل مکمل است؛ نبودش دفتر را از کار نمی‌اندازد */ });
      return bootstrap;
    } catch (error) {
      notify(error.message);
      return null;
    } finally {
      setLoading(false);
    }
  }, [notify, refreshVoiceSystemStatus]);

  const { intentDraft, setIntentDraft, settleDraft, setSettleDraft, saveIntentDraft, applySettlement, queueSettlementReview } = useIntentDrafts({ load, notify });

  useEffect(() => {
    const requireAuth = () => { localStorage.removeItem('hesab-yar-authenticated'); api.clearOfflineSession(); setAuthenticated(false); };
    window.addEventListener('hesabyar:auth-required', requireAuth);
    if (!navigator.onLine && localStorage.getItem('hesab-yar-authenticated') === '1') setAuthenticated(true);
    else api.authStatus().then((result) => { setAuthenticated(result.authenticated); if (result.authenticated) setAccess(accessFromPayload(result)); }).catch((error) => { setAuthError(error.message); setAuthenticated(false); });
    return () => window.removeEventListener('hesabyar:auth-required', requireAuth);
  }, []);

  useEffect(() => { if (authenticated && !access.user?.mustChangePassword) load(); }, [authenticated, access.user?.mustChangePassword, load]);

  useOfflineAudioSync({ online, authenticated, offlineScopeReady, offlineUserId, offlineWorkspaceId, parseResult, setParseResult, setPendingAudioCount, load, notify });

  useEffect(() => {
    if (!undoSave) return undefined;
    const timer = window.setTimeout(() => setUndoSave(null), 9_000);
    return () => window.clearTimeout(timer);
  }, [undoSave]);

  useEffect(() => {
    if (!redoSave) return undefined;
    const timer = window.setTimeout(() => setRedoSave(null), 12_000);
    return () => window.clearTimeout(timer);
  }, [redoSave]);

  const openCorrection = useCallback(async (command) => {
    if (!online) {
      setFailure({ transcript: command, message: 'اصلاح آخرین ثبت برای اطمینان از انتخاب رکورد درست، به اتصال اینترنت نیاز دارد.' });
      return;
    }
    try {
      const result = await api.latestTransaction();
      if (!result.item) {
        setFailure({ transcript: command, message: 'هنوز تراکنشی وجود ندارد که اصلاحش کنم.' });
        return;
      }
      const preview = previewCorrection(command, result.item, { learnings: data.learnings, accounts: data.accounts, categories: data.categories });
      if (!preview.canApply) {
        setFailure({ transcript: command, message: `${preview.explanation} مثلاً بگو «نه، هفتصد و پنجاه هزار بود» یا «بزن هزینه پیک».` });
        return;
      }
      setCorrectionDraft({ command, current: result.item, preview });
    } catch (error) { notify(error.message); }
  }, [data.accounts, data.categories, data.learnings, notify, online]);

  const {
    recordState, voicePath, liveTranscript, liveVoiceNote, livePreview, levels, holdingRef, fastVoiceAvailable,
    startRecording, stopRecording, cancelProcessing,
  } = useVoiceCapture({
    data, online, notify, refreshVoiceSystemStatus, voiceSystemStatusRef, openCorrection,
    // routeIntent پایین‌تر تعریف می‌شود؛ هنگام صدا زدن، نسخهٔ همین رندر را می‌خواند.
    routeIntent: (...args) => routeIntent(...args),
    setFailure, setParseResult, setPendingAudioCount, activeOfflineScope,
  });

  const parseManual = async (event) => {
    event?.preventDefault();
    const text = manualText.trim();
    if (!text) return;
    if (isCorrectionCommand(text)) {
      setManualText('');
      await openCorrection(text);
      return;
    }
    if (routeIntent(text, 'text')) { setManualText(''); return; }
    // همان کنترلی که سرور روی مسیر صدا می‌زند؛ ثبت متنی محلی پارس می‌شود و نباید
    // از الگوی خودِ پرونده بی‌خبر بماند.
    // پارسر به تومان می‌خواند (مردم «تومان» می‌گویند)؛ نتیجه پیش از هر مقایسه با دفتر به واحد دفتر می‌رود.
    const result = applyDnaSignals(parseResultInLedgerUnit(parseFinancialText(text, { learnings: data.learnings, averages: averagesInToman(data.averages), source: 'text' })), data.dnaProfiles);
    if (!result.transactions?.length) setFailure({ transcript: text, message: result.clarification });
    else { setParseResult({ ...result, engine: 'local-text', latencyMs: 0 }); setManualText(''); }
  };

  /**
   * گفته‌ای که طلب، بدهی، چک یا فاکتور است نباید به‌عنوان تراکنش ساده ثبت شود.
   * هیچ‌چیز خودکار ذخیره نمی‌شود؛ فقط کارت تأیید باز می‌شود.
   */
  // وضعیت کلید «همه را اول AI بفهمد» از سیاست دفتر، و آیا اجرا شدنی است.
  const aiForAll = aiForAllState(data.understanding, access.workspace?.role);
  const toggleAiForAll = async () => {
    if (aiToggleBusy) return;
    setAiToggleBusy(true);
    try {
      await api.setUnderstandingForAll(!aiForAll.on);
      await load();
      notify(!aiForAll.on
        ? 'از این به بعد همهٔ گفته‌ها اول با AI فهمیده می‌شوند و بعد به موتور قاعده می‌روند.'
        : 'فقط گفته‌های مرکب به AI می‌روند؛ بقیه از مسیر سریع و رایگان.');
    } catch (error) { notify(error.message); } finally { setAiToggleBusy(false); }
  };

  const routeIntent = (transcript, source = 'voice') => {
    if (!canWrite) return false;
    // «همه را اول AI بفهمد» روشن است: هر گفته — حتی ساده و حتی آن‌هایی که کارت قطعی
    // دارند — اول به فهم رویداد می‌رود و خروجی ساخت‌یافته‌اش به موتور قاعده. آفلاین
    // یا بی‌کلید AI، همان مسیر قطعی کار می‌کند؛ گفته گم نمی‌شود.
    if (aiForAll.on && aiForAll.ready && online) {
      void openUnderstanding(transcript, source);
      return true;
    }
    // پرداخت یا شارژ تنخواه پیش از همه: «تنخواه رو شارژ کردیم» مبلغ ندارد ولی
    // مبلغش معلوم است (همان خرج‌شده)، و «از ملت به تنخواه منتقل کردیم» مقصدش
    // در حساب‌های عادی نیست. هیچ‌کدام هزینه نیست.
    const pettyFunding = detectPettyCashFunding(transcript, { accounts: data.accounts || [] });
    if (pettyFunding) { setIntentDraft(draftInLedgerUnit(pettyFunding)); return true; }
    // بدهی شرکت که شریک یا مدیرعامل از پول شخصی‌اش داد: نه پولی از صندوق رفته،
    // نه فروش داراییِ او درآمد شرکت است. کارت تسویه سند باز را می‌بندد و طرفش
    // جاری همان شریک می‌شود.
    const partnerPaid = detectPartnerPaidDebt(transcript);
    if (partnerPaid) { setSettleDraft(draftInLedgerUnit(partnerPaid)); return true; }
    // فهم گفتهٔ مرکب با AI، فقط وقتی دفتر آن را فعال کرده. همان گفته‌هایی که
    // مسیر قطعی امروز به حسابدار می‌داد یا تکه‌تکه می‌کرد؛ گفتهٔ ساده همان مسیر
    // رایگان می‌ماند.
    const understanding = data.understanding;
    if (understanding?.mode === 'active' && understanding.engineV2 && understanding.available && online
      && inUnderstandingScope(transcript, understanding.scope)) {
      void openUnderstanding(transcript, source);
      return true;
    }
    if (needsUnquantifiedReview(transcript)) {
      if (!online) { setFailure({ transcript, message: 'برای ذخیره درخواست بررسی حسابدار اتصال اینترنت لازم است.' }); return true; }
      void api.queueUnquantifiedReview({ transcript, source, clientId: crypto.randomUUID() })
        .then(() => notify(UNQUANTIFIED_REVIEW_REASON))
        .catch(error => setFailure({ transcript, message: error.message }));
      return true;
    }
    if (hasCompositeAmounts(transcript)) {
      if (!online) { setFailure({ transcript, message: `${COMPOSITE_AMOUNT_MESSAGE} اتصال اینترنت لازم است تا این گفته در صف حسابدار ذخیره شود.` }); return true; }
      void api.queueCompositeReview({ transcript, source, clientId: crypto.randomUUID() })
        .then(() => notify('کل گفته با همهٔ مبلغ‌ها به‌صورت یک مورد به صف حسابدار رفت؛ سندی ثبت نشد.'))
        .catch((error) => setFailure({ transcript, message: `${error.message} گفته را دوباره بررسی و ارسال کن.` }));
      return true;
    }
    // تسویه پیش از ساخت سنجیده می‌شود: «طلب رضایی وصول شد» هم واژهٔ «طلب» دارد
    // هم فعل تسویه، و اگر اول مسیر ساخت برود یک طلب تازه می‌سازد به‌جای بستن
    // طلب موجود.
    const transfer = detectCaptureTransfer(transcript, { accounts: data.accounts || [] });
    if (transfer) { setIntentDraft(draftInLedgerUnit(transfer)); return true; }
    const settle = detectSettleIntent(transcript);
    if (settle) { setSettleDraft(draftInLedgerUnit(settle)); return true; }
    const found = detectVoiceIntent(transcript);
    if (!found) return false;
    setIntentDraft(draftInLedgerUnit(found));
    return true;
  };

  /**
   * پروندهٔ فهم گفته. برگه بلافاصله با متن کاربر باز می‌شود و پس از فهم، همان
   * پرونده را نشان می‌دهد. شکستِ فهم، مسیر قدیمی را بی‌صدا جایگزین نمی‌کند؛
   * پرونده با وضعیت «ناموفق» و دکمهٔ تلاش دوباره می‌ماند.
   */
  const openUnderstanding = async (transcript, source) => {
    setUnderstandingDraft({ transcript, status: 'extracting' });
    try {
      const { item } = await api.createUnderstandingCase({ text: transcript, source, clientId: crypto.randomUUID() });
      setUnderstandingDraft(item);
    } catch (error) {
      setUnderstandingDraft(null);
      setFailure({ transcript, message: error.message });
    }
  };

  const queueLearningSuggestion = (transactions, transcript) => {
    const corrected = transactions.find((item) => item.originalCategory && item.originalCategory !== item.category);
    if (!corrected) return;
    const keyword = inferLearningKeyword(corrected.rawText || transcript);
    if (keyword.length >= 2) setLearningSuggestion({ keyword, category: corrected.category });
  };

  const finalizeOfflineAudio = async (offlineAudioId) => {
    if (!offlineAudioId || !offlineScopeReady) return;
    const scope = activeOfflineScope();
    await removeOfflineAudio(offlineAudioId, scope).catch(() => {});
    setPendingAudioCount(await countOfflineAudio(scope).catch(() => 0));
  };

  const persistConfirmed = async (payload, transactions, allowDuplicates = false, offlineAudioId = '') => {
    const result = await api.saveTransactions({ ...payload, allowDuplicates });
    await finalizeOfflineAudio(offlineAudioId);
    // اصلاحِ ثبت قبلی تراکنش تازه نمی‌سازد؛ کاربر باید بداند کجا رفت.
    if (result.queuedForAccountant) notify(`ردیف نقدی ساخته نشد و به صف حسابدار رفت: ${result.queuedReasons?.[0] || 'این جمله تراکنش نقدی تازه نیست.'}`);
    // «نسیه»، «هنوز پرداخت نکردیم»: پولی جابه‌جا نشد ولی طلب یا بدهی ساخته شد.
    else if (result.nonCash?.length) {
      const [first] = result.nonCash;
      notify(first.status === 'posted'
        ? 'پولی جابه‌جا نشد؛ طلب یا بدهی ثبت شد و ماندهٔ صندوق و بانک دست نخورد.'
        : `پولی جابه‌جا نشد؛ طلب یا بدهی ساخته شد${first.question ? ` و یک سؤال مانده: «${first.question}» — از برگهٔ بررسی جواب بده.` : '.'}`);
    }
    setUndoSave(result.ids?.length ? { ids: result.ids, count: result.ids.length } : null);
    setRedoSave(null);
    setDuplicatePrompt(null);
    setParseResult(null);
    queueLearningSuggestion(transactions, payload.transcript);
    await load();
  };

  /**
   * ساخت حساب بانک، همان‌جا که کمبودش دیده شد.
   *
   * فرستادن کاربر به تنظیمات وسط یک ثبت، یعنی ثبت را رها کند و برگردد. و
   * تجربه نشان داد که برنمی‌گردد: همهٔ هزینه‌ها روی صندوق ماندند.
   */
  const createBankAccount = async ({ name, bankId }) => {
    try {
      const account = await api.saveAccount({ name, kind: 'bank', bankId, openingBalance: 0 });
      await load();
      notify(`حساب «${account.name}» ساخته شد؛ موجودی اولیه‌اش را از تنظیمات وارد کن.`);
      return account;
    } catch (error) { notify(error.message); return null; }
  };

  const saveConfirmed = async (transactions) => {
    const offlineAudioId = parseResult.offlineAudioId || '';
    const payload = { transcript: parseResult.transcript, transactions };
    try {
      if (!online) {
        queueTransactions(payload, activeOfflineScope());
        await finalizeOfflineAudio(offlineAudioId);
        setParseResult(null);
        notify('ثبت شد؛ بعد از اتصال فقط در همین دفتر همگام می‌شود.');
        await load();
      } else {
        await persistConfirmed(payload, transactions, false, offlineAudioId);
      }
    } catch (error) {
      if (error.code === 'POSSIBLE_DUPLICATE') {
        setDuplicatePrompt({ payload, transactions, offlineAudioId, duplicates: error.details?.duplicates || [] });
      } else notify(error.message);
    }
  };

  const confirmDuplicate = async () => {
    if (!duplicatePrompt) return;
    const transactions = duplicatePrompt.transactions.map((item) => ({
      ...item, needsReview: false, reviewState: 'duplicate-confirmed',
      reviewReasons: [...(item.reviewReasons || []), 'شباهت با ثبت اخیر به کاربر نمایش داده شد و ثبت جداگانه تأیید شد.'],
    }));
    try {
      await persistConfirmed(
        { ...duplicatePrompt.payload, transactions }, transactions, true, duplicatePrompt.offlineAudioId || '',
      );
    } catch (error) { notify(error.message); }
  };

  const discardParseResult = async () => {
    const offlineAudioId = parseResult?.offlineAudioId;
    if (offlineAudioId) await finalizeOfflineAudio(offlineAudioId);
    setParseResult(null);
  };

  const undoLastSave = async () => {
    const snapshot = undoSave;
    if (!snapshot?.ids?.length || undoing) return;
    setUndoing(true);
    setUndoSave(null);
    try {
      for (const id of snapshot.ids) await api.deleteTransaction(id);
      await load();
      setRedoSave(snapshot);
      notify(snapshot.ids.length > 1 ? 'ثبت‌های اخیر با سند معکوس برگردانده شدند.' : 'ثبت اخیر با سند معکوس برگردانده شد.');
    } catch (error) { notify(error.message); }
    finally { setUndoing(false); }
  };

  const redoLastUndo = async () => {
    const snapshot = redoSave;
    if (!snapshot?.ids?.length || undoing) return;
    setUndoing(true);
    setRedoSave(null);
    try {
      const restored = [];
      for (const id of snapshot.ids) restored.push((await api.redoTransaction(id)).item.id);
      setUndoSave({ ids: restored, count: restored.length });
      await load();
      notify(restored.length > 1 ? 'ثبت‌ها با سند تازه دوباره ایجاد شدند.' : 'ثبت با سند تازه دوباره ایجاد شد.');
    } catch (error) { notify(error.message); }
    finally { setUndoing(false); }
  };

  const applyCorrection = async () => {
    if (!correctionDraft) return;
    try {
      const result = await api.correctTransaction(correctionDraft.current.id, correctionDraft.command);
      const categoryChanged = result.interpretation?.changedFields?.includes('category');
      if (categoryChanged) {
        const keyword = inferLearningKeyword(correctionDraft.command);
        if (keyword.length >= 2) setLearningSuggestion({ keyword, category: result.item.category });
      }
      setCorrectionDraft(null);
      await load();
      notify('آخرین ثبت با سند معکوس اصلاح شد.');
    } catch (error) {
      if (error.code === 'LATEST_TRANSACTION_CHANGED') setCorrectionDraft(null);
      notify(error.message);
    }
  };

  const acceptLearning = async () => {
    const suggestion = learningSuggestion;
    setLearningSuggestion(null);
    if (!suggestion) return;
    try { await api.saveLearning(suggestion); await load(); notify('این نگاشت با تأیید تو یاد گرفته شد.'); }
    catch (error) { notify(error.message); }
  };

  const login = async (username, password) => {
    setAuthError('');
    try {
      const result = await api.login(username, password);
      setAccess(accessFromPayload(result));
      localStorage.setItem('hesab-yar-authenticated', '1');
      setAuthenticated(true);
    } catch (error) { setAuthError(error.message); }
  };

  const logout = async () => {
    if (parseResult?.offlineAudioId && offlineScopeReady) {
      await releaseOfflineAudio(parseResult.offlineAudioId, activeOfflineScope(), 'خروج کاربر پیش از تأیید').catch(() => {});
    }
    try { await api.logout(); } catch { /* پاک‌کردن نشست محلی حتی اگر شبکه قطع باشد */ }
    localStorage.removeItem('hesab-yar-authenticated');
    api.clearOfflineSession();
    setParseResult(null);
    setPendingAudioCount(0);
    setData({ transactions: [], summary: EMPTY_SUMMARY, categories: [], accounts: [], settings: {}, learnings: [], averages: {}, dnaProfiles: null, overview: {}, contacts: [], obligations: [], recurring: [], closings: [], closingPreview: null });
    setAccess({ user: null, workspaces: [], workspace: null });
    setAuthenticated(false);
  };

  const switchWorkspace = async (workspaceId) => {
    if (!workspaceId || workspaceId === access.workspace?.id) return;
    if (!online) { notify('برای تغییر دفتر ابتدا به اینترنت وصل شو؛ ثبت‌های آفلاین در دفتر فعلی محفوظ‌اند.'); return; }
    if (parseResult?.offlineAudioId && offlineScopeReady) {
      await releaseOfflineAudio(parseResult.offlineAudioId, activeOfflineScope(), 'تغییر دفتر پیش از تأیید').catch(() => {});
    }
    const previousWorkspaceId = access.workspace?.id || '';
    api.selectWorkspace(workspaceId);
    setLoading(true);
    // تا رسیدن تحلیل دفتر تازه، تحلیل دفتر قبلی باید برود.
    setData((previous) => ({ ...previous, overview: {}, dnaProfiles: null }));
    setParseResult(null);
    setPendingAudioCount(0);
    setFailure(null);
    const loaded = await load();
    if (!loaded) {
      api.selectWorkspace(previousWorkspaceId);
      notify('تغییر دفتر کامل نشد و دفتر قبلی فعال ماند.');
      return;
    }
    navigate('today');
    notify('دفتر فعال عوض شد.');
  };
  const snoozeAlert = async (alertId) => {
    try { await api.snoozeAlert(alertId, 24); await load(); notify('این هشدار تا ۲۴ ساعت پنهان شد.'); }
    catch (error) { notify(error.message); }
  };

  // حالِ حسابی (نماد نوار ضبط) از همان وضعیت‌هایی که برگه‌ها را باز می‌کنند.
  const mascot = {
    mood: mascotMood({
      recordState, manualText, savedRecently: Boolean(undoSave), reviewing: Boolean(parseResult),
      analyzing: understandingDraft?.status === 'extracting',
      asking: Boolean((understandingDraft && understandingDraft.status !== 'extracting') || possibleDuplicate || duplicatePrompt || intentDraft || correctionDraft),
      worried: Boolean(overdraftPrompt || failure),
    }),
    alert: mascotAlert({ overdraftPrompt, failure }),
  };
  if (authenticated === null) return <div dir="rtl" className="grid min-h-screen place-items-center bg-paper text-ink"><span className="h-8 w-8 animate-spin rounded-full border-2 border-line border-t-accent" aria-label="در حال بارگذاری" /></div>;
  if (!authenticated) return <LoginPage onLogin={login} error={authError} />;
  if (access.user?.mustChangePassword) return <main dir="rtl" className="min-h-screen bg-paper py-10 text-ink"><div className="mx-auto max-w-[760px] px-4"><p className="text-sm font-bold text-accent">اولین ورود</p><h1 className="mt-2 text-2xl font-extrabold">رمز موقتت را عوض کن</h1><p className="mt-2 text-sm leading-7 text-muted">برای حفاظت از اطلاعات مالی، تا تعیین رمز شخصی امکان ورود به دفتر وجود ندارد.</p></div><Suspense fallback={<ScreenLoading />}><PasswordPanel notify={notify} onChanged={logout} /></Suspense></main>;

  const canWrite = ['owner', 'manager', 'accountant'].includes(access.workspace?.role);

  return (
    <div dir="rtl" className="min-h-screen bg-paper text-ink">
      {!online && <div className="sticky top-0 z-50 flex h-9 items-center justify-center gap-2 bg-ink px-4 text-[13px] text-on-fill"><WifiOff size={15} /> آفلاین — ضبط ذخیره می‌شود و بعداً ارسال</div>}
      <div className="app-shell mx-auto min-h-screen w-full max-w-[1440px] bg-paper">
        {/* P1 بازخورد UX: skip-link — نخستین عنصر قابل فوکوس صفحه؛ کاربر صفحه‌خوان
            یا کیبوردی بدون رد شدن از ناوبری، مستقیم به محتوای اصلی می‌رود. */}
        <a href="#main-content" className="skip-link">پرش به محتوای اصلی</a>
        <DesktopNav screen={screen} section={section} searchRef={menuSearchRef} navigate={navigate} businessName={data.settings.businessName} profileType={data.settings.profileType} access={access} switchWorkspace={switchWorkspace} />
        <div id="main-content" className="safe-bottom min-w-0 lg:col-start-2">
          <header className="workspace-topbar"><div className="flex min-w-0 items-center gap-3"><button type="button" onClick={() => setDrawer(true)} aria-label="بازکردن منوی بخش‌ها" aria-expanded={drawer} className="tap grid place-items-center rounded-lg border border-line lg:hidden hover:bg-paper hover:text-ink"><Menu size={21} /></button><div className="min-w-0"><p className="text-xs text-muted">{access.workspace?.name || data.settings.businessName || 'دفتر فعال'}</p><Breadcrumb access={access} screen={screen} section={section} profileType={data.settings.profileType} /></div></div><div className="flex shrink-0 items-center gap-2"><span className="hidden rounded-full border border-line bg-paper px-3 py-1 text-xs text-muted sm:inline">مبالغ به {unitLabel()}</span><ThemeToggle /></div></header>
          <Suspense fallback={<ScreenLoading />}>
          {/* کلید = صفحه؛ عوض‌شدنش فقط همین پوسته را دوباره سوار می‌کند و گذر آرام یک‌بار اجرا می‌شود.
              تعویض بخش‌های درون یک صفحه (مثل برگه‌های دفتر) کلید را عوض نمی‌کند تا همان‌جا سریع بماند. */}
          <div key={screen} className="screen-enter">
          {screen === 'today' && (
            <TodayPage
              data={data} loading={loading} manualText={manualText} setManualText={setManualText}
              parseManual={parseManual} recordState={recordState}
              stopRecording={stopRecording} cancelProcessing={cancelProcessing} beginRecording={() => { holdingRef.current = true; startRecording(); }}
              levels={levels} liveTranscript={liveTranscript} liveVoiceNote={liveVoiceNote} livePreview={livePreview} fastVoiceAvailable={fastVoiceAvailable}
              voicePath={voicePath} voiceSystemStatus={voiceSystemStatus} readOnly={!canWrite}
              aiForAll={{ ...aiForAll, busy: aiToggleBusy, online }} onToggleAiForAll={toggleAiForAll}
              reviewing={Boolean(parseResult)} savedRecently={Boolean(undoSave)} pendingAudioCount={pendingAudioCount}
              navigate={navigate} onOpenClosing={() => setCloseDayOpen(true)} onSelectTransaction={setSelectedDecision} onSnoozeAlert={snoozeAlert}
              notify={notify} refreshToday={load} experience={access.experience} mascot={mascot}
            />
          )}
          {screen === 'ledger' && <LedgerPage profileType={data.settings.profileType} categories={data.categories} accounts={data.accounts} contacts={data.contacts} notify={notify} refresh={load} initialTab={LEDGER_SECTIONS[section] || 'transactions'} cardSection={CARD_SECTIONS[section] || ''} onTabChange={(id) => { setSection(id); writeRoute('ledger', id); }} navigate={navigate} />}
          {screen === 'report' && <ReportPage profileType={data.settings.profileType} navigate={navigate} notify={notify} />}
          {screen === 'accounting-reports' && <AccountingReportsPage access={access} notify={notify} />}
          {screen === 'review' && <ReviewQueuePage notify={notify} access={access} navigate={navigate} refresh={load} />}
          {screen === 'accounting' && data.settings.profileType === 'business' && <AccountingPage access={access} notify={notify} initialSection={section} onSectionChange={(id) => { setSection(id); writeRoute('accounting', id); }} />}
          {screen === 'tax' && data.settings.profileType === 'business' && <TaxPage access={access} notify={notify} />}
          {screen === 'firm' && <FirmConsolePage access={access} notify={notify} switchWorkspace={switchWorkspace} refreshAccess={async () => { const result = await api.workspaces(); setAccess(accessFromPayload(result)); }} />}
          {screen === 'chart' && data.settings.profileType === 'business' && <ChartPage access={access} notify={notify} refreshApp={load} initialTab={section} onTabChange={(id) => { setSection(id); writeRoute('chart', id); }} />}
          {screen === 'collaboration' && data.settings.profileType === 'business' && <CollaborationPage access={access} notify={notify} navigate={navigate} initialTab={section} />}
          {screen === 'dna' && data.settings.profileType === 'business' && <DnaPage notify={notify} />}
          {screen === 'petty-cash' && data.settings.profileType === 'business' && <PettyCashPage accounts={data.accounts} access={access} notify={notify} refresh={load} autoCreate={section === 'new'} />}
          {screen === 'settings' && (() => {
            // تنظیمات یک ستون بلند بود: پشتیبان و رمز ته صفحه گم می‌شدند. حالا هر
            // بخش زبانهٔ خودش را دارد و از منو مستقیم باز می‌شود.
            const screens = allowedScreens(access);
            const tabs = SETTINGS_SECTIONS.filter(([id]) => !SETTINGS_REQUIRES[id] || screens.some((item) => item.id === SETTINGS_REQUIRES[id]));
            const part = tabs.some(([id]) => id === section) ? section : 'general';
            const canManageWorkspace = ['owner', 'manager'].includes(access.workspace?.role);
            const refreshAccess = async () => { const result = await api.workspaces(); setAccess(accessFromPayload(result)); };
            return <>
              <div className="mx-auto w-full max-w-[760px] px-4"><nav aria-label="بخش‌های تنظیمات" className="section-navigation">{tabs.map(([id, label]) => <button type="button" key={id} aria-current={part === id ? 'page' : undefined} onClick={() => navigate('settings', id)}>{label}</button>)}</nav></div>
              {part === 'general' && <><section className="mx-auto mt-2 w-full max-w-[760px] px-4"><div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line bg-surface p-4"><div><h2 className="font-extrabold">ظاهر برنامه</h2><p className="mt-1 text-xs text-muted">«خودکار» از تنظیم دستگاه پیروی می‌کند.</p></div><ThemeChoice /></div></section><SettingsPage initial={data.settings} accounts={data.accounts} notify={notify} refresh={load} onLogout={logout} canManage={canManageWorkspace} /></>}
              {part === 'accounts' && <AccountsPanel accounts={data.accounts} canManage={canManageWorkspace} notify={notify} refresh={load} />}
              {part === 'team' && <><ExportAccessCard access={access} navigate={navigate} notify={notify} refreshAccess={refreshAccess} /><Suspense fallback={null}><WorkspacePanel access={access} notify={notify} switchWorkspace={switchWorkspace} refreshAccess={refreshAccess} /></Suspense></>}
              {part === 'backup' && <BackupPanel access={access} notify={notify} refresh={load} />}
              {part === 'privacy' && <DataPrivacyPanel access={access} notify={notify} />}
              {part === 'security' && <><SessionsPanel notify={notify} /><PasswordPanel notify={notify} onChanged={logout} /><LogoutPanel onLogout={logout} /></>}
              {part === 'learning' && <LearningPage categories={data.categories} notify={notify} role={access.workspace?.role} />}
            </>;
          })()}
          </div>
          </Suspense>
        </div>
        <CounterpartyMatchSheet />
      </div>

      <BottomNav screen={screen} navigate={navigate} access={access} />
      {drawer && <Drawer screen={screen} section={section} profileType={data.settings.profileType} close={() => setDrawer(false)} navigate={navigate} access={access} switchWorkspace={switchWorkspace} />}
      {parseResult && (
        <ConfirmationSheet
          result={parseResult} categories={data.categories} accounts={data.accounts} contacts={data.contacts || []}
          onCreateBankAccount={createBankAccount} onCancel={discardParseResult} onConfirm={saveConfirmed}
        />
      )}
      {overdraftPrompt && <OverdraftApprovalSheet prompt={overdraftPrompt} canApprove={['owner', 'manager', 'accountant'].includes(access.workspace?.role)}
        close={(reason) => { overdraftPrompt.resolve(reason); setOverdraftPrompt(null); }} />}
      {failure && <FailureSheet failure={failure} close={() => setFailure(null)} retry={() => { setFailure(null); holdingRef.current = true; startRecording(); }} manual={() => { setFailure(null); document.getElementById('manual-entry')?.focus(); }} />}
      {correctionDraft && <CorrectionSheet draft={correctionDraft} accounts={data.accounts} close={() => setCorrectionDraft(null)} confirm={applyCorrection} />}
      {duplicatePrompt && <DuplicateSheet prompt={duplicatePrompt} close={() => setDuplicatePrompt(null)} confirm={confirmDuplicate} />}
      {possibleDuplicate && <PossibleDuplicateSheet prompt={possibleDuplicate} close={(confirmed) => { possibleDuplicate.resolve(confirmed); setPossibleDuplicate(null); }} />}
      {learningSuggestion && <LearningSuggestionSheet suggestion={learningSuggestion} close={() => setLearningSuggestion(null)} confirm={acceptLearning} />}
      {intentDraft && <IntentSheet draft={intentDraft} setDraft={setIntentDraft} accounts={data.accounts || []} close={() => setIntentDraft(null)} confirm={saveIntentDraft} />}
      {understandingDraft && <Suspense fallback={null}><UnderstandingSheet draft={understandingDraft} setDraft={setUnderstandingDraft} close={() => setUnderstandingDraft(null)} notify={notify}
        onPosted={() => { notify('پرونده ثبت شد؛ فقط اجزای انجام‌شده سند خوردند.'); void load(); }} /></Suspense>}
      {settleDraft && <SettleSheet draft={settleDraft} obligations={data.obligations || []} contacts={data.contacts || []} close={() => setSettleDraft(null)} confirm={applySettlement} queueReview={queueSettlementReview} />}
      {selectedDecision && <DecisionDetailsSheet access={access} navigate={navigate} item={selectedDecision} close={() => setSelectedDecision(null)} />}
      {closeDayOpen && <CloseDaySheet data={data} close={() => setCloseDayOpen(false)} onComplete={async () => { setCloseDayOpen(false); await load(); notify('امروز بسته شد و نتیجه در سابقهٔ صندوق ماند.'); }} />}
      {undoSave && <div role="status" className="fixed bottom-28 left-1/2 z-[80] flex w-[calc(100%-32px)] max-w-[460px] -translate-x-1/2 items-center gap-3 rounded-lg bg-ink px-4 py-3 text-sm text-on-fill shadow-paper"><Check size={19} className="shrink-0 text-income" /><span className="min-w-0 flex-1">{undoSave.count > 1 ? `${toPersianDigits(undoSave.count)} مورد ذخیره شد؛ وضعیت نهایی را در فهرست بررسی کن.` : 'مورد ذخیره شد؛ وضعیت نهایی را در فهرست بررسی کن.'}</span><button disabled={undoing} onClick={undoLastSave} className="tap min-w-0 rounded-md border border-on-fill/30 px-3 text-xs font-extrabold">برگردان</button></div>}
      {redoSave && <div role="status" className="fixed bottom-28 left-1/2 z-[80] flex w-[calc(100%-32px)] max-w-[460px] -translate-x-1/2 items-center gap-3 rounded-lg bg-ink px-4 py-3 text-sm text-on-fill shadow-paper"><RotateCcw size={19} className="shrink-0 text-income" /><span className="min-w-0 flex-1">{redoSave.count > 1 ? 'ثبت‌ها برگردانده شدند.' : 'ثبت برگردانده شد.'}</span><button disabled={undoing} onClick={redoLastUndo} className="tap min-w-0 rounded-md border border-on-fill/30 px-3 text-xs font-extrabold">دوباره انجام بده</button></div>}
      {toast && <div role="status" className="fixed bottom-28 left-1/2 z-[80] w-[calc(100%-32px)] max-w-[430px] -translate-x-1/2 rounded-lg bg-ink px-4 py-3 text-center text-sm text-on-fill shadow-paper">{toast}</div>}
      {data.settings.onboardingDone === 'false' && <Onboarding initial={data.settings} onDone={async (values) => { const result = await api.settings({ ...values, onboardingDone: 'true' }); setData((current) => ({ ...current, settings: result.settings })); }} />}
    </div>
  );
}

/** مسیر بالای صفحه: «گروه › بخش»، تا کاربر همیشه بداند کجای منوست. */
function Breadcrumb({ access, screen, section, profileType }) {
  const groups = visibleMenu(allowedScreens(access), { ledgerTabs: profileDefinition(profileType).ledgerTabs });
  const found = findMenuItem(groups, screen, section);
  const fallback = allowedScreens(access).find((item) => item.id === screen)?.label || 'حساب‌یار';
  return <p className="mt-1 flex min-w-0 flex-wrap items-center gap-1 text-sm font-extrabold">
    {found ? <><span className="font-bold text-muted">{found.group.label}</span><span aria-hidden="true" className="text-muted">›</span><span>{found.item.label}</span></> : fallback}
  </p>;
}
