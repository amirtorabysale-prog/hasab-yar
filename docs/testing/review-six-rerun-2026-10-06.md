# Production follow-up rerun — 2026-10-06

Release verified by public /api/health: `7cde67ba047071e758d3b8c65e4aea66fb316705`, ok:true. Main quality and security checks succeeded. Test office: بازآزمایی ۴۰ سناریو بدون AI — ۱۴ مهر ۱۴۰۵.

This is a continuation of the existing ten-case queue workflow, not a fresh forty-case suite. Seven existing event journals were inspected without duplicate posting. Three pending cases were freshly analyzed and posted through the UI.

| Case | Result | Journal |
|---|---|---|
| T006 | Dr supplier-linked purchase advance 120m; Cr Saman 120m; new supplier and analytic created | 1405/9 |
| T031 | Dr Mellat 50m; Cr Mohammadi receivable 50m; receivable cleared | 1405/11 |
| T079 | Dr Saman 10m; Cr VAT refund claim 10m; linked to prior claim, cleared | 1405/13 |
| T055 | Existing Dr electricity expense 7m; Cr cash 7m verified | 1405/6 |
| T071 | Existing Dr fixed assets 100m; Cr Saman 100m verified | 1405/7 |
| T062 | Existing Dr refundable deposit with broker analytic 20m; Cr Saman 20m verified | 1405/8 |

T031 and T079 originally had no prior balance in the test office. Explicit synthetic documented-opening fixtures were entered through the new manager-only queue form: 50m dated 2026-09-30 and 10m dated 2026-09-29. Separate basis journals 1405/10 and 1405/12 debit the relevant claim and credit opening equity. These fixtures are test setup, not evidence of actual company balances. The subsequent event journals require separate approval.

Total ten-case workflow completion increased from 7/10 to 10/10; this is not a 100% autonomous accuracy score. The four previous cases T037, T120, T083 and T076 were also inspected. T076 still uses general tax/dues expense instead of a dedicated penalty account; tax treatment was not validated. T071 asset-register and depreciation lifecycle were outside the journal check. Opening-equity account 3000 in basis journals shows no chart mapping. Those limitations remain.

All event journals are balanced; event dates remain 2026-10-06, while older claim fixture dates remain separate. Trial balance totals are 355,600,000 on each side; receivable and tax-claim debit/credit movements cancel after collection. Thirteen journals exist: ten tested event journals, two separate basis fixtures, and the pre-existing rent journal. Source transaction IDs and actual journal UUIDs are in the adjacent evidence JSON.

Date-input automation required native Arrow-key changes after fill to commit React state; no hidden state or signed-in API bypass was used. No new code, merge, or deployment was performed during this rerun.
