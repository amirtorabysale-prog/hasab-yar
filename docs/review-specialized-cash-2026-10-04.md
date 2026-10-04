# Review assistant: specialized cash approval and catalog binding

Based on the ten live retests after PR83. This change is implementation and local regression validation; it does not claim a fresh live-model success rate.

## Behavior

- Prepaid assets, refundable deposits, loan principal payable, customer advances and deferred revenue can post a balanced two-line cash journal on explicit accountant approval. Cash balances, source transaction, party analytics, journal and DNA acceptance commit together; reversal deletes the source cash movement and reverses the journal together.
- `transactions.accounting_role` is an additive migration. These movements retain their direction for bank reconciliation but are excluded from current revenue/expense summaries, category reports, typical amounts, insights, backup summaries and ordinary counterparty settlement interpretation. Simple transaction edits/deletes cannot overwrite specialized accounting; correction uses its review/event journal.
- Deposit and loan roles are distinct from prepaid rent, trade payables and income. They may need dedicated subsidiaries in an existing company's custom chart; no deposit/loan chart mapping is inferred from similar trade or prepaid names.
- Model-selected bank/person/product ledger IDs are replaced with deterministic identity resolution. Incompatible inventory IDs cannot become an expense ledger. A contradictory account/subsidiary pair is resolved to the requested subsidiary's ledger rather than silently remapping an existing ledger. Amounts, economic roles and dates are never repaired by this binding layer; unsafe nature/amount proposals stay blocked.
- Original capture transcript is retained before date/bank masking. Original row evidence takes priority over a masked sentence. Coverage/useful-life paraphrases are deduplicated; unanswered or repeated unanswered business facts continue blocking posting.
- Known bank-to-cash mapping mistakes block posting. If exactly one bank subsidiary exists, the review shows an explicit repair action and how many existing journal lines' chart display changes. Only that action updates the mapping, records old/new IDs in the audit and requests new analysis. No mapping changes happen during analysis or deployment.
- Queue changes refresh shared account balances immediately.

## Limits

This does not automatically schedule amortization of an AI-reviewed insurance contract, resolve missing coverage dates/useful lives/capitalization policy, guess deposit maturity or loan terms, or correct historical posted amounts. Unbalanced AI output still blocks; no fabricated balancing line or autonomous model retry is added. API analysis remains on request with cache/staleness controls. Historical masked originals cannot be reconstructed where the original was never retained.

## Validation

Full suite: 1,390 cases, 1,385 passing, five existing skips, zero failures. Production build passed. Added integration regressions cover all five specialized roles, synchronized balances and reversal, report exclusion, ordinary-edit locks, duplicate approval, safe bank-mapping repair, inventory/party bindings, original unmasked evidence and question deduplication. Rendering checks assert explicit historical-impact disclosure before mapping repair.

Production dependency audit still reports the existing Tailwind/braces vulnerability chain (five high, one moderate); this PR does not suppress the audit or perform a breaking Tailwind migration. Live ten-case retest is still required after merge/deployment.
