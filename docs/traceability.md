# Простежуваність: spec → code → tests (Task C)

**Специфікація:** `docs/spec/pricing-discounts.md` (D-1…D-24, AC-1…AC-31)
**Реалізація:** `app/src/discounts.ts`
**Тести:** `app/src/discounts.test.ts`
**Мутаційна перевірка:** `app/scripts/mutation-check.mjs`

Перевірено: `cd app && npm test` — 40 зелених (8 засіяних + 32 за критеріями),
`npm run typecheck` — без помилок, `npm run mutation-check` — 18 із 18 мутацій
спіймано.

## Таблиця

| AC | Що перевіряє | Де реалізовано (файл:символ) | Тест (назва) | Статус |
|---|---|---|---|---|
| AC-1 | Знижка за рівнем Gold без промокодів (D-1, D-15) | `discounts.ts:priceOrder` → крок 2, `tierDiscount` | `AC-1: Gold on 1000 грн, no coupons — tier discount only` | ✅ |
| AC-2 | Рівень і купон послідовно, не додаванням (D-1) | `discounts.ts:priceOrder` → крок 3, `base` | `AC-2: tier and coupon apply sequentially, not additively` | ✅ |
| AC-3 | Два купони на одну категорію, порядок введення (D-3, D-5) | `discounts.ts:priceOrder` → крок (ж) | `AC-3: two coupons on the same category, both applied in entry order` | ✅ |
| AC-4 | `fixed` більший за замовлення — обрізання (D-7, D-13) | `discounts.ts:priceOrder` → крок (и), `Math.min(raw, base)` | `AC-4: a fixed coupon larger than the order clamps to the base` | ✅ |
| AC-5 | Межа «на або після» рівно в момент закінчення (D-9) | `discounts.ts:priceOrder` → крок (д), `nowMs >= expiresAtMs` | `AC-5: a coupon is expired at exactly its expiry instant` | ✅ |
| AC-6 | Порожнє замовлення з купоном (D-17, D-18) | `discounts.ts:priceOrder` → `subtotal === 0`, крок (ж) | `AC-6: an empty order with a coupon prices to zero without throwing` | ✅ |
| AC-7 | Пів копійки округлюється вниз (D-4) | `discounts.ts:priceOrder` → `Math.floor` у кроках 2 і (з) | `AC-7: half a kopeck rounds down, not up` | ✅ |
| AC-8 | Невідомий код не ламає замовлення (D-10) | `discounts.ts:priceOrder` → крок (в), `matches.length === 0` | `AC-8: an unknown code is rejected and the rest still apply` | ✅ |
| AC-9 | Той самий код двічі — застосовується раз (D-11, D-12) | `discounts.ts:priceOrder` → крок (б), `seen` | `AC-9: the same code entered twice applies once` | ✅ |
| AC-10 | Поріг проти вихідного subtotal, сума рівно на порозі (D-6) | `discounts.ts:priceOrder` → крок (е), `subtotal <` | `AC-10: the threshold is judged against the original subtotal` | ✅ |
| AC-11 | Сума нижча за поріг (D-6) | `discounts.ts:priceOrder` → крок (е) | `AC-11: an order below the threshold rejects the coupon` | ✅ |
| AC-12 | `percent` > 100 невалідний (D-16) | `discounts.ts:isValidValue` | `AC-12: a percent coupon above 100 is invalid` | ✅ |
| AC-13 | Silver 5%, none 0 (D-15) | `discounts.ts:priceOrder` → крок 2, `tierPercent` | `AC-13: silver discounts 5%, none discounts 0` | ✅ |
| AC-14 | Цифрове замовлення: доставка 0, знижка діє (D-2) | `discounts.ts:priceOrder` → крок 5, `shippingKopecks` | `AC-14: an all-digital order ships free and still discounts` | ✅ |
| AC-15 | Пропорційне зменшення бази категорії, точне відношення без переповнення (D-5) | `discounts.ts:priceOrder` → крок (ж), `BigInt(categoryItems) * BigInt(base) / BigInt(subtotal)` | `AC-15: the category base shrinks proportionally with the tier discount` | ✅ |
| AC-16 | `fixed` по категорії обрізається до бази D-5 (D-13) | `discounts.ts:priceOrder` → крок (з), `Math.min(coupon.value, couponBase)` | `AC-16: a fixed category coupon clamps to the proportional category base` | ✅ |
| AC-17 | Рівень діє на всі категорії (D-15) | `discounts.ts:priceOrder` → крок 2 (без фільтра за категорією) | `AC-17: the tier discount covers every category without exception` | ✅ |
| AC-18 | Відʼємний `value` невалідний (D-16) | `discounts.ts:isValidValue` → `coupon.value < 0` | `AC-18: a negative percent value is invalid` | ✅ |
| AC-19 | Купон із нульовою знижкою — застосований (D-18) | `discounts.ts:priceOrder` → `appliedCoupons.push(code)` без умови на `discount` | `AC-19: a coupon that discounts nothing is still applied` | ✅ |
| AC-20 | Категорійний купон на кошик без категорії (D-19) | `discounts.ts:priceOrder` → крок (є), `order.items.some` | `AC-20: a category coupon on a cart without that category is rejected` | ✅ |
| AC-21 | Дедуплікація по побачених, не по застосованих (D-12 × D-19) | `discounts.ts:priceOrder` → `seen.add(code)` перед рештою перевірок | `AC-21: a repeat of an already-rejected code reports duplicate, not the first reason` | ✅ |
| AC-22 | Порядок введення змінює підсумок (D-14) | `discounts.ts:priceOrder` → `for (const rawCode of order.coupons)` без сортування | `AC-22: entry order changes the total — coupons are never reordered` | ✅ |
| AC-23 | Крайні пробіли й регістр ігноруються, внутрішні — ні (D-11) | `discounts.ts:normalizeCode` | `AC-23: edge whitespace and case are ignored, inner whitespace is not` | ✅ |
| AC-24 | Непарсабельна й неіснуюча дата — `invalid`, не вічний купон (D-20) | `discounts.ts:parseUnambiguousInstant`, `isRealCalendarDate` | `AC-24: an unparseable expiry is invalid, not eternal` | ✅ |
| AC-25 | Дата+час без зсуву неоднозначна (D-20) | `discounts.ts:DATE_ONLY`, `DATE_TIME_WITH_OFFSET` | `AC-25: a date-time without an offset is invalid; with one, or date-only, it is not` | ✅ |
| AC-26 | `NaN` не отруює жодного поля (D-16) | `discounts.ts:isValidValue` → `Number.isInteger` | `AC-26: a NaN value is invalid and poisons no field` | ✅ |
| AC-27 | Двобічна нормалізація, колізія в каталозі, непридатний `code` (D-21) | `discounts.ts:priceOrder` → крок (в), `catalog.filter(hasMatchableCode && normalizeCode)` | `AC-27: catalog codes are normalised too; a collision is invalid` | ✅ |
| AC-28 | Зіпсований поріг невалідний, відсутній — ні (D-20) | `discounts.ts:isValidMinSubtotal` | `AC-28: a corrupt minimum threshold is invalid; an absent one is not` | ✅ |
| AC-29 | Непридатний `now` — `invalid`, не вічний купон; пріоритет причин збережено (D-23) | `discounts.ts:priceOrder` → `nowIsUsable`, крок (д) | `AC-29: an unusable `now` rejects coupons rather than making them eternal` | ✅ |
| AC-30 | Невідомий `kind` — `invalid`, а не мовчазний `fixed` (D-24) | `discounts.ts:isSupportedKind`, крок (г) | `AC-30: an unsupported kind is invalid, not silently treated as fixed` | ✅ |
| AC-31 | Незліченне замовлення й переповнення грошової арифметики — `TypeError`, а не отруєна розбивка (D-22) | `discounts.ts:assertComputableOrder`, крок 0: `Number.isSafeInteger` на полі й добутку, `MAX_SUBTOTAL_KOPECKS` на накопиченій сумі (запас під `+ shipping` і `× percent`) | `AC-31: a corrupt order throws rather than returning a poisoned breakdown` | ✅ |

**Інваріанти контракту** (§5 специфікації) перевіряються не окремим рядком, а
хелпером `expectInvariants` на результаті **кожного** критерію, що повертає
розбивку: інваріант за визначенням має триматися скрізь, тож перевірка в одній
точці перевіряла б майже нічого. Виняток один — **AC-31**: там розбивки немає
взагалі, бо саме її відсутність і є перевірюваною поведінкою (D-22). Обчислювані
замовлення в межах того самого критерію проходять `expectInvariants` як звичайно.

## Зворотна перевірка

### Чи є в коді поведінка, якої немає в жодному AC?

**Немає** — після виправлення. Перший прохід знайшов одну: `isValidMinSubtotal`
(перевірка `minSubtotalKopecks` на ціле невідʼємне) реалізовувала другу половину
пункту (б) з D-20, але не мала власного критерію — AC-24…AC-26 покривали
`expiresAt` і `value`, а поріг лишався без числа. Поведінка не була зайвою
(специфікація її просить), проте не була закріплена тестом.

→ **Дія:** дописано **AC-28** у специфікацію та відповідний тест. Вибір саме
такий, а не «прибрати з коду», бо D-20 цю перевірку прямо вимагає: відʼємний
поріг інакше проходив би перевірку (е) для будь-якого замовлення, оскільки
`subtotal >= -1` завжди істинно. Мутація «пропустити перевірку порога» тепер
ловиться (`npm run mutation-check`).

Решта коду мапиться на критерії один в один. Зайвої «ініціативи» (кешування,
логування, підбору найвигіднішого купона, сортування, знижки на доставку)
немає — усе, що є, названо в D-1…D-24.

→ **Пізніші доповнення.** Чотири перевірки додано вже після першого проходу, і
кожна пройшла той самий цикл «рішення → критерій → код → тест → мутація», а не
потрапила в код тихо: **D-22** (незліченне замовлення, AC-31), **D-23**
(непридатний `now`, AC-29), **D-24** (невідомий `kind`, AC-30) і розширення
**D-21** на не-рядковий `code` (у межах AC-27). Спільна риса всіх чотирьох —
поле, яке `types.ts` описує типом, але каталог, замовлення чи виклик можуть
порушити: тип був прийнятий за гарантію там, де її немає.

D-22 при цьому єдина, що не вкладається у схему «зіпсовані дані → причина
відхилення»: зіпсована позиція не лишає осмисленої відповіді, тож вона й стала
єдиним винятком у всій специфікації. Це звузило обіцянку §5 з «завжди повертає
`PriceBreakdown`» до «для будь-якого обчислюваного `Order`» — зміна контракту,
зафіксована в самому §5, а не прихована в коді.

### Чи є AC без тесту?

**Немає.** 31 з 31 мають тест, названий за своїм ID. Перевірено збігом імен:
кожен `it(...)` у `discounts.test.ts` починається з `AC-N:`, і множина цих N
дорівнює 1…31.

### Чи є тест, який не мапиться на жоден AC?

**Один**, навмисно: `AC-1..31: the calculation is pure — inputs are not mutated,
no clock is read`. Він перевіряє не окремий критерій, а два інваріанти з §5
контракту (чистота функції й детермінізм), які стосуються всіх критеріїв
одразу. Названий діапазоном, щоб у виводі vitest було видно, що це не сирота,
а перевірка наскрізної властивості.

## Що з цього вийшло

Зворотна перевірка знайшла **одну прогалину в критеріях** — незакріплену
перевірку `minSubtotalKopecks` — при тому, що таблиця AC→код→тест виглядала
повною. Саме зворотний прохід, а не прямий, показав розбіжність. Закрито
критерієм AC-28: специфікацію довелося дописати, а не код підрізати.

Другу — і серйознішу — розбіжність знайшов не цей документ, а **мутаційна
перевірка** реалізації (`app/scripts/mutation-check.mjs`): навмисні зміни коду
під рішення D-4…D-21 показали, що два тести проходили **з неправильною
реалізацією**. AC-7 перевіряв округлення лише на кроці рівня, тож заміна
`floor`→`round` у купонному кроці лишалась непоміченою; AC-26 подавав `NaN` як
`percent`, а той відсікався пізнішою перевіркою діапазону — тобто тест проходив
із хибної причини, хоча саме `NaN` був приводом для D-16. Обидва тести
підсилено в межах їхніх критеріїв; код не змінювався — він був правильний
із самого початку. Зараз ловляться всі 18 мутацій.

Скрипт закомічено навмисно, а не лишено разовим прогоном: він і є той артефакт,
який відрізняє «тести зелені» від «поведінку перевірено». Кожна мутація — це
альтернативне прочитання неоднозначності, яке спека закрила; якщо колись
зʼявиться рядок `SURVIVED`, це означатиме, що відповідне рішення D-N перестало
бути закріпленим, і таблиця вище показує його статус занадто оптимістично.

Головний висновок: специфікація була повна **щодо поведінки** — усі критерії
реалізувалися без суперечностей, а нормативний порядок обчислення з §3
переклався в код майже рядок у рядок. Але повнота специфікації не означає
повноти тестів: зелений набір сам по собі не доводить, що поведінку перевірено.
Доводить це лише спроба зламати реалізацію.
