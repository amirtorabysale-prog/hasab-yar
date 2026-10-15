import React from 'react';

/**
 * بدون این، یک خطای رندر کل برنامه را سفید می‌کند و کاربر هیچ راهی جز بستن
 * مرورگر ندارد — همان اتفاقی که یک تاریخ نامعتبر در کارتابل سند می‌انداخت.
 *
 * برنامه‌ای که دادهٔ مالی نگه می‌دارد نباید صفحهٔ سفید نشان بدهد: کاربر
 * نمی‌داند ثبتش رفته یا نه. حداقل کاری که باید بکند این است که بگوید چه شد،
 * راه برگشت بدهد و بگوید دادهٔ ذخیره‌شده دست‌نخورده است.
 */
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // در Production هم لاگ می‌ماند تا بتوان علت را از گزارش کاربر پیدا کرد.
    console.error('[hesab-yar] خطای رندر', error, info?.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-[560px] flex-col justify-center px-4 py-10">
        <section className="rounded-2xl border border-line bg-surface p-5">
          <p className="text-[12px] font-extrabold text-expense">خطای نمایش</p>
          <h1 className="mt-2 text-xl font-extrabold">این صفحه بالا نیامد</h1>
          <p className="mt-3 text-[13px] leading-7 text-muted">
            ایراد از نمایش است، نه از داده‌ات. هر چیزی که تا این لحظه ثبت شده روی سرور دست‌نخورده باقی مانده است.
          </p>
          <p className="mt-3 rounded-lg bg-paper px-3 py-2 text-xs leading-6 text-muted" dir="ltr">
            {String(this.state.error?.message || this.state.error).slice(0, 300)}
          </p>
          <div className="mt-5 grid grid-cols-2 gap-2">
            <button
              onClick={() => window.location.reload()}
              className="tap rounded-lg bg-ink font-extrabold text-on-fill hover:bg-ink/90"
            >
              بارگذاری دوباره
            </button>
            <button
              onClick={() => { window.location.href = '/'; }}
              className="tap rounded-lg border border-line bg-surface font-bold hover:bg-paper hover:text-ink"
            >
              بازگشت به صفحهٔ اول
            </button>
          </div>
          <p className="mt-4 text-xs leading-6 text-muted">
            اگر باز هم تکرار شد، همین متن خطا را برای پشتیبانی بفرست؛ برای پیداکردن علت کافی است.
          </p>
        </section>
      </main>
    );
  }
}
