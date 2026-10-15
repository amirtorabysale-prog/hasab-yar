import { useState } from 'react';
import { Landmark, Mic } from 'lucide-react';
import { api } from '../../lib/api.js';
import { detectBankMovementIntent } from '../../../shared/bankSpeech.js';
import { createPersianRecognizer, liveSpeechErrorMessage, liveSpeechSupported } from '../../lib/liveSpeech.js';
import { formatAmount } from '../../lib/format.js';

/**
 * گفتنِ کار بانکی، همان‌جا که تطبیق بانک انجام می‌شود.
 *
 * دو کاری که تا امروز فقط از تنظیمات ممکن بود و وسط کار روزانه کسی سراغشان
 * نمی‌رفت: ساختن حساب بانک، و جابه‌جایی پول میان حساب‌های خودمان.
 *
 * دومی مهم‌تر است: «دو میلیون از صندوق به بانک ملت واریز شد» نه درآمد است نه
 * هزینه. تا امروز راهی برایش نبود و کاربر مجبور بود یک هزینه از صندوق و یک
 * درآمد در بانک ثبت کند — و سود همان ماه دو بار جعل می‌شد.
 *
 * طرفِ گفته‌نشده هرگز حدس زده نمی‌شود: پول از حسابی که کسی نگفته نباید کم
 * شود. برگه می‌پرسد و کاربر انتخاب می‌کند.
 */
export default function BankVoicePanel({ accounts = [], notify, refresh }) {
  const [heard, setHeard] = useState('');
  const [draft, setDraft] = useState(null);
  const [listening, setListening] = useState(false);
  const [busy, setBusy] = useState(false);
  const [typed, setTyped] = useState('');

  const active = accounts.filter((account) => account.active !== false);

  const understand = (text) => {
    const intent = detectBankMovementIntent(text, { accounts: active });
    setHeard(text);
    if (!intent) {
      setDraft(null);
      notify('این جمله کار بانکی نبود؛ برای هزینه و درآمد از صفحهٔ اصلی بگو.');
      return;
    }
    setDraft(intent);
  };

  const listen = () => {
    if (!liveSpeechSupported()) { notify('مرورگر این دستگاه تشخیص زندهٔ فارسی ندارد؛ جمله را بنویس.'); return; }
    const recognizer = createPersianRecognizer({
      onUpdate: (snapshot) => setHeard(snapshot.transcript || ''),
      onEnd: () => setListening(false),
      onError: (code) => { setListening(false); notify(liveSpeechErrorMessage(code)); },
    });
    if (!recognizer) return;
    recognizer.onresult = recognizer.onresult;
    setListening(true);
    try { recognizer.start(); } catch { setListening(false); }
    // پایان گفتن، همان لحظه فهمیده می‌شود؛ متن نهایی از snapshot می‌آید.
    window.setTimeout(() => { try { recognizer.stop(); } catch { /* بسته شده */ } }, 8_000);
  };

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      if (draft.intent === 'create-account') {
        const account = await api.saveAccount({
          name: draft.bankName, kind: 'bank', bankId: draft.bankId, openingBalance: draft.openingBalance || 0,
        });
        notify(`حساب «${account.name}» ساخته شد${draft.openingBalance ? ` با موجودی ${formatAmount(draft.openingBalance)} تومان` : ''}.`);
      } else {
        await api.transferBetweenAccounts({
          fromAccountId: draft.fromAccountId, toAccountId: draft.toAccountId,
          amount: draft.amount, note: draft.transcript,
        });
        notify(`${formatAmount(draft.amount)} تومان منتقل شد؛ این جابه‌جایی نه درآمد است نه هزینه.`);
      }
      setDraft(null); setHeard(''); setTyped('');
      await refresh?.();
    } catch (error) { notify(error.message); }
    setBusy(false);
  };

  const pick = (side) => (event) => setDraft({ ...draft, [side]: event.target.value });
  const ready = draft && (draft.intent === 'create-account' || (draft.fromAccountId && draft.toAccountId));

  return <section className="rounded-xl border border-line bg-surface p-4">
    <div className="flex items-start justify-between gap-3">
      <div className="flex items-start gap-3">
        <Landmark className="mt-1 shrink-0 text-accent" />
        <div>
          <h2 className="font-extrabold">کار بانکی با صدا</h2>
          <p className="mt-1 max-w-xl text-xs leading-6 text-muted">
            «حساب بانک ملت را بساز» · «دو میلیون از صندوق به بانک ملت واریز شد» · «پنج میلیون از بانک ملت برداشت شد».
            جابه‌جایی پول میان حساب‌های خودت نه درآمد است نه هزینه و در سود دوره نمی‌آید.
          </p>
        </div>
      </div>
      <button type="button" onClick={listen} disabled={listening}
        className={`tap grid shrink-0 place-items-center rounded-lg border px-3 ${listening ? 'border-expense bg-expense/10 text-expense' : 'border-line text-accent'}`}
        aria-label="گفتن کار بانکی"><Mic size={19} /></button>
    </div>

    <div className="mt-3 flex flex-wrap gap-2">
      <input value={typed} onChange={(event) => setTyped(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Enter' && typed.trim()) understand(typed.trim()); }}
        placeholder="یا همین‌جا بنویس: دو میلیون از صندوق به بانک ملت واریز شد"
        className="tap min-w-0 flex-1 rounded-lg border border-line bg-paper px-3 text-[13px]" />
      <button onClick={() => typed.trim() && understand(typed.trim())}
        className="tap rounded-lg border border-line bg-paper px-4 text-[13px] font-bold hover:bg-paper hover:text-ink">بررسی</button>
    </div>

    {listening && <p className="mt-2 text-xs font-bold text-expense">در حال شنیدن…</p>}
    {heard && <blockquote className="mt-2 rounded-lg border border-line bg-paper px-3 py-2 text-[12px] leading-6 text-muted">«{heard}»</blockquote>}

    {draft?.intent === 'create-account' && <div className="mt-3 rounded-lg border border-accent/50 bg-warn-bg px-3 py-3 text-[13px]">
      <p className="font-extrabold text-accent">ساخت حساب «{draft.bankName}»</p>
      <p className="mt-1 text-[12px] leading-6 text-muted">
        {draft.openingBalance
          ? <>با موجودی اولیهٔ <b className="numbers text-ink">{formatAmount(draft.openingBalance)}</b> تومان؛ همان لحظه سند افتتاحیه می‌خورد.</>
          : 'بدون موجودی اولیه. هر وقت خواستی از تنظیمات واردش کن.'}
      </p>
    </div>}

    {draft?.intent === 'transfer' && <div className="mt-3 rounded-lg border border-accent/50 bg-warn-bg px-3 py-3">
      <p className="text-[13px] font-extrabold text-accent">انتقال {formatAmount(draft.amount)} تومان</p>
      {draft.partial && <p className="mt-1 text-[12px] leading-6 text-muted">
        فقط یک طرف را گفتی. طرف دیگر را خودت انتخاب کن — پول از حسابی که کسی نگفته نباید کم شود.
      </p>}
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <label className="text-xs text-muted">از حساب
          <select value={draft.fromAccountId || ''} onChange={pick('fromAccountId')}
            className="tap mt-1 block w-full rounded-lg border border-line bg-paper px-2 text-[13px] text-ink">
            <option value="">— انتخاب کن —</option>
            {active.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
          </select>
        </label>
        <label className="text-xs text-muted">به حساب
          <select value={draft.toAccountId || ''} onChange={pick('toAccountId')}
            className="tap mt-1 block w-full rounded-lg border border-line bg-paper px-2 text-[13px] text-ink">
            <option value="">— انتخاب کن —</option>
            {active.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
          </select>
        </label>
      </div>
    </div>}

    {draft && <button disabled={!ready || busy} onClick={save}
      className="tap mt-3 rounded-lg bg-accent px-4 font-bold text-on-fill disabled:opacity-45 hover:bg-accent/90 active:bg-accent/80">
      {busy ? 'در حال ثبت…' : draft.intent === 'create-account' ? 'بساز' : 'ثبت انتقال'}
    </button>}
  </section>;
}
