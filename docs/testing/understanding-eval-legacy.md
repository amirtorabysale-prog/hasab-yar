# ارزیابی فهم رویداد — legacy

اجرا: 2026-10-09T06:25:21.617Z · مجموعه: `understanding-acceptance-v1` · 60 گفته

| شاخص | مقدار |
|---|---|
| correct | 15 |
| protectiveStop | 35 |
| partialPost | 7 |
| wrongPost | 3 |
| errors | 0 |
| routes | {"ready":10,"needs-answers":31,"needs-accountant":19,"no-entry":0,"failed":0} |
| fakeAmounts | 1 |
| doubleCounted | 0 |
| latencyMs | {"median":3,"max":104} |

| گفته | مسیر | داوری | جزئیات |
|---|---|---|---|
| E01/formal | needs-accountant | stop | needs-accountant |
| E01/colloquial | needs-answers | stop | needs-answers |
| E01/reordered | needs-answers | stop | needs-answers |
| E01/extra-sentence | needs-accountant | stop | needs-accountant |
| E01/negation | needs-accountant | stop | needs-accountant |
| E01/self-correction | needs-accountant | stop | needs-accountant |
| E02/formal | needs-accountant | stop | needs-accountant |
| E02/colloquial | needs-accountant | stop | needs-accountant |
| E02/reordered | needs-accountant | stop | needs-accountant |
| E02/extra-sentence | needs-accountant | stop | needs-accountant |
| E02/negation | needs-accountant | wrong-post | posted cash-out:120000000 |
| E02/self-correction | needs-accountant | stop | needs-accountant |
| E03/formal | needs-answers | stop | needs-answers |
| E03/colloquial | needs-answers | stop | needs-answers |
| E03/reordered | needs-answers | stop | needs-answers |
| E03/extra-sentence | needs-answers | stop | needs-answers |
| E03/negation | needs-accountant | stop | needs-accountant |
| E03/self-correction | needs-answers | correct | needs-answers |
| E04/formal | ready | correct | ready |
| E04/colloquial | ready | correct | ready |
| E04/reordered | ready | correct | ready |
| E04/extra-sentence | ready | correct | ready |
| E04/negation | needs-answers | correct | needs-answers |
| E04/self-correction | needs-accountant | correct | needs-accountant |
| E05/formal | needs-answers | stop | needs-answers |
| E05/colloquial | ready | correct | ready |
| E05/reordered | ready | correct | ready |
| E05/extra-sentence | needs-answers | stop | needs-answers |
| E05/negation | needs-accountant | correct | needs-accountant |
| E05/self-correction | needs-answers | stop | needs-answers |
| E06/formal | needs-answers | stop | needs-answers |
| E06/colloquial | needs-answers | stop | needs-answers |
| E06/reordered | needs-answers | stop | needs-answers |
| E06/extra-sentence | ready | correct | ready |
| E06/negation | ready | correct | ready |
| E06/self-correction | needs-accountant | stop | needs-accountant |
| E07/formal | needs-answers | stop | needs-answers |
| E07/colloquial | needs-answers | stop | needs-answers |
| E07/reordered | needs-accountant | stop | needs-accountant |
| E07/extra-sentence | needs-answers | stop | needs-answers |
| E07/negation | needs-answers | correct | needs-answers |
| E07/self-correction | needs-answers | stop | needs-answers |
| E08/formal | needs-accountant | partial | missing obligation-receivable:35000000 |
| E08/colloquial | needs-answers | stop | needs-answers |
| E08/reordered | needs-accountant | partial | missing obligation-receivable:35000000 |
| E08/extra-sentence | needs-accountant | partial | missing obligation-receivable:35000000 |
| E08/negation | ready | wrong-post | posted cash-in:60000000 |
| E08/self-correction | needs-accountant | stop | needs-accountant |
| E09/formal | needs-answers | stop | needs-answers |
| E09/colloquial | needs-answers | stop | needs-answers |
| E09/reordered | needs-answers | stop | needs-answers |
| E09/extra-sentence | needs-answers | stop | needs-answers |
| E09/negation | needs-answers | correct | needs-answers |
| E09/self-correction | needs-answers | stop | needs-answers |
| E10/formal | needs-answers | partial | missing transfer:30000000 |
| E10/colloquial | needs-answers | partial | missing transfer:30000000 |
| E10/reordered | ready | wrong-post | expected cash-out:20000,transfer:30000000 got cash-out:20000,cash-out:30000000 |
| E10/extra-sentence | needs-answers | partial | missing transfer:30000000 |
| E10/negation | needs-answers | correct | needs-answers |
| E10/self-correction | needs-answers | partial | missing transfer:30000000 |
