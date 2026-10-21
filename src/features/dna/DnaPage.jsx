import { DnaHelix } from '../../components/DnaHelix.jsx';
import { FinancialDnaPanel } from './FinancialDnaPanel.jsx';

/**
 * DNA مالی، بخشِ جدای منو (خواستهٔ مالک محصول، ۲۹ مهر ۱۴۰۵: «بخش DNA را یک بخش جدا در
 * دسته‌بندی قرار بده و داخلش از انیمیت استفاده کن»). پیش از این برگهٔ سومِ «همکاری با
 * حسابدار» بود و کنار تحویل پارسیان گم می‌شد.
 *
 * نمادِ مارپیچ فقط یک بار، هنگام باز شدن، چند دور می‌چرخد و می‌ایستد؛ داده‌ای که حسابدار
 * می‌خواند تکان نمی‌خورد.
 */
export function DnaPage({ notify }) {
  return <main className="mx-auto w-full max-w-[980px] px-4 py-5">
    <header className="flex items-center gap-4">
      <span className="dna-hero-tile grid h-[92px] w-[92px] shrink-0 place-items-center rounded-2xl border border-line bg-surface">
        <DnaHelix variant="hero" size={72} label="نماد DNA مالی" />
      </span>
      <div className="min-w-0">
        <h1 className="text-xl font-extrabold">DNA مالی</h1>
        <p className="mt-1 max-w-[620px] text-sm leading-7 text-muted">اثر انگشت رفتاری همین پرونده: کِی و چقدر ثبت می‌شود، چه چیزی عادی است و چه چیزی نه. هر عدد از ثبت‌های واقعی می‌آید؛ تا دادهٔ کافی نباشد، هیچ الگویی ادعا نمی‌شود.</p>
      </div>
    </header>
    <FinancialDnaPanel notify={notify} />
  </main>;
}
