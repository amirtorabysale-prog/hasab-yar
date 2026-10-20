import { formatAmount } from '../../lib/format.js';
import { ROLE_LABELS } from './reviewCase.js';

const NEW_ACCOUNT_TYPES = { asset: 'دارایی', liability: 'بدهی', expense: 'هزینه', income: 'درآمد' };

/**
 * سند به شکلی که خوانده شود: هر سطر نامِ حساب و نقشِ فارسی‌اش، بدهکار و بستانکار جدا.
 * هم سندِ پیشنهادی AI و هم سندِ آمادهٔ تأیید (برنامهٔ ثبت) همین را نشان می‌دهند.
 */
export function EntryTable({ lines = [], title = 'سند' }) {
  if (!lines.length) return null;
  return <div className="mt-3 overflow-x-auto rounded-lg border border-line">
    <table className="w-full text-right text-[13px]">
      <caption className="sr-only">{title}</caption>
      <thead className="bg-paper text-[12px] text-muted"><tr><th className="px-3 py-2 font-bold">حساب</th><th className="px-3 py-2 font-bold">بدهکار</th><th className="px-3 py-2 font-bold">بستانکار</th></tr></thead>
      <tbody>{lines.map((line, index) => <tr key={index} className="border-t border-line align-top">
        <td className="px-3 py-2">
          <span className="font-bold">{[line.accountCode, line.accountName || line.label || line.key].filter(Boolean).join(' ') || ROLE_LABELS[line.role] || line.role}</span>
          <span className="ms-1 text-muted">({ROLE_LABELS[line.role] || line.role})</span>
          {line.newAccount && <span className="mt-0.5 block text-[12px] text-accent">ساخت همراه سند · {NEW_ACCOUNT_TYPES[line.newAccount.type] || 'سرمایه'}{line.newAccount.chartCode ? ` · معین ${line.newAccount.chartCode} ${line.newAccount.chartName || ''}` : ''}</span>}
        </td>
        <td className="numbers whitespace-nowrap px-3 py-2">{line.debit ? formatAmount(line.debit) : '—'}</td>
        <td className="numbers whitespace-nowrap px-3 py-2">{line.credit ? formatAmount(line.credit) : '—'}</td>
      </tr>)}</tbody>
    </table>
  </div>;
}
