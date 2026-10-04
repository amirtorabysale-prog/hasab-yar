# Live retest after PR 84 — 2026-10-04

Production and main were verified at `bbb6948ac1b9c58ffde1a6c598175d22b085a6d8`; health returned 200/ok and the live bundle was `index-Blf17xXj.js`. All synthetic submissions and approvals were confined to the named workspace `ازمایشی`. No deployment, merge, or historical journal reversal was performed.

## Ten scenario results

| Case | Amount (toman) | Observed result on PR84 |
|---|---:|---|
| N01 Courier expense from Saman | 200,000 | Wrong ready proposal: debit wages despite courier explanation. Not approved. |
| N02 Printing services received | 700,000 | Posted document 16: debit Saman / credit services income. |
| N03 Saman to Pasargad transfer | 500,000 | Posted document 17: debit Pasargad / credit Saman. No income/expense. |
| N04 Insurance paid before six-month coverage | 6,000,000 | Posted document 19: debit prepaid insurance / credit Saman. Payment journal only; amortization schedule not created. |
| N05 Refundable deposit | 4,000,000 | Posted document 20: debit refundable deposit linked to test counterparty / credit Saman. |
| N06 Receipt of loan principal | 2,000,000 | Posted document 18: debit Saman / credit loan payable linked to test lender. |
| N07 Printer for office use | 5,000,000 | Correctly held for useful life and capitalization policy; no invented journal. |
| N08 Delivered resale inventory bought on credit | 800,000 | Redundant questions about stated quantity/unit, duplicate party questions, an invalid-plan response after answers, then confirmation word included in party identity. After explicit name correction the balanced inventory/payable plan remained blocked by an unnecessary trade maturity question. Not approved. |
| N09 Advance for future services | 1,000,000 | Posted document 21: debit Saman / credit customer advance with counterparty analytic. No current revenue. |
| N10 Correction request without known amount | Unknown | Follow-up case with tracking identifier, no fictitious amount or journal. A timeout around capture completion led to submitting this synthetic input twice; two follow-up cases exist. Neither was deleted. |

6/10 scenarios produced verified correct final journals; 2/10 correctly stayed in review; 2/10 exposed defects. This is 80% acceptable handling on these ten examples, not a population accuracy estimate. All six approved journals were inspected in the live document detail UI and balanced. The courier's incorrect suggestion was never posted. The inventory case remains open.

Before direct transfer, the old Saman ledger was found mapped to the cash subsidiary. The explicit repair action in the test workspace changed its mapping to the bank subsidiary and disclosed five affected historical lines. No amounts or historical entries were changed. Direct transfer lacked the corresponding posting guard.

## Corrections in this PR

- Resolve expense/income category bindings against the deterministic category chart suggestion; a wages subsidiary cannot silently substitute for courier costs. Validate again at preparation/approval, and invalidate earlier cached suggestions.
- Block normal journal insertion when an operational bank is mapped to a cash subsidiary, covering direct transfer and other normal posting paths. Require explicit repair; exempt opening/reversal history. The guard does not change mappings.
- Exclude bank/person names and generic capture wording from DNA similarity and discard known incompatible economic families. An unrelated service receipt must not become loan/deposit guidance merely through the same bank.
- Deduplicate paraphrased party-name, inventory quantity and unit questions.
- Remove a delimited confirmation prefix (e.g. `بله،`) from the derived party name without rewriting the stored conversation.
- Strengthen the AI instruction to use explicit delivered inventory facts and allow creation of missing product/person identities after approval. Do not ask users to choose accounting accounts.
- Treat maturity as optional for the supported two-line delivered inventory/trade payable shape, while retaining mandatory cheque maturity. Preserve optional questions in proposal evidence.
- Distinguish an empty AI response from invalid/unbalanced amounts. No automatic balancing, repeated API calls, or invented facts were introduced.

## Validation and remaining limits

Local suite: 1,396 tests, 1,391 passed, 5 skipped, 0 failed. Production build passed. Regressions cover wrong same-type chart binding, atomic transfer rejection/repair, irrelevant DNA, duplicate question boxes, confirmation-name handling and trade-vs-cheque maturity.

These new changes have not yet been deployed or live-retested. Prompt improvements cannot guarantee every model response is correct; the deterministic posting checks remain necessary. An invalid model output stays in review.

The existing test workspace lacks chart mappings for the new loan, refundable-deposit and customer-advance ledgers. Their accounting identities and analytics are correct, but export coding is not complete; creating/installing or explicitly approving dedicated chart subsidiaries remains required. Insurance expense recognition over time is also a separate workflow. Existing dependency security-audit failure on main was observed separately from successful quality checks and is not suppressed by this PR.
