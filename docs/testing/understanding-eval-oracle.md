# ارزیابی فهم رویداد — oracle

اجرا: 2026-10-09T10:43:59.925Z · مجموعه: `understanding-acceptance-v1` · 10 گفته

| شاخص | مقدار |
|---|---|
| correct | 8 |
| protectiveStop | 2 |
| partialPost | 0 |
| wrongPost | 0 |
| errors | 0 |
| routes | {"ready":8,"needs-answers":1,"needs-accountant":1,"no-entry":0,"failed":0} |
| fakeAmounts | 0 |
| amountsFound | 18/18 |
| datesFound | 3/3 |
| questions | 1 |
| unbalanced | 0 |
| wrongAccount | 0 |
| aiCalls | 10 |
| tokens | {"input":0,"output":0} |
| latencyMs | {"median":54,"max":66} |

| گفته | مسیر | داوری | جزئیات |
|---|---|---|---|
| E01/formal | ready | correct | ready |
| E02/formal | ready | correct | ready |
| E03/formal | ready | correct | ready |
| E04/formal | ready | correct | ready |
| E05/formal | ready | correct | ready |
| E06/formal | needs-answers | stop | needs-answers |
| E07/formal | needs-accountant | stop | needs-accountant |
| E08/formal | ready | correct | ready |
| E09/formal | ready | correct | ready |
| E10/formal | ready | correct | ready |
