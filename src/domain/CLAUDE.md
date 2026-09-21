# server/domain — business logic

40 modules in **10 folders by business area**. Pure functions over a `PoolClient`: the
caller (an API route) opens the transaction; domain code never opens, commits or rolls
back.

```
core/         order-lifecycle, outbox, exceptions, auth, entitlements, flags,
              order-search — called from everywhere; order-lifecycle alone is
              pulled in by 9 other domain modules
orders/       recalc, order-token, expire, agreement, customer-history,
              confirm-deadline
pricing/      pricing, upsell, limits
availability/ availability, nearby, blackout, waitlist, demand, schedule
fitting/      din, fitting, fit-rules
counter/      counter, shift, stocktake
service/      service — работы техника: что в обслуживании и возврат
              в оборот. ⚠️ Строится ИЗ ДВИЖЕНИЙ (to_service/from_service),
              отдельной таблицы заявок нет: вторая таблица со своим
              статусом разошлась бы с движениями
inventory/    items — единицы с номером и QR (уровень `labeled`).
              ⚠️ Номера НЕ переиспользуются: счёт от максимума среди
              ВСЕХ единиц, включая архивные. ⚠️ «Удалить» = archived_at:
              на единицу ссылаются movement и order_line, а наличие —
              это сумма движений
admin/        admin, reports, privacy, bulk, branch-clone, texts,
              texts.templates, demo
platform/     api-key, reminders
```

⚠️ Grouped by **business area, not by `server/api` section**, and that is deliberate:
16 of 36 modules are called from several sections at once (`auth` from four —
admin, counter, platform, staff), so an api-shaped split would force an arbitrary
choice for nearly half of them. A module used by several sections belongs to `core/`.

⚠️ **Tests live next to the module**: `server/domain/<area>/test/<name>.test.ts`.
Schema-level invariants (RLS, EXCLUDE) are not about a module — they are in
`server/db/test/`.

⚠️ Domain must not import `server/integrations` — enforced by `dependency-cruiser`.
⚠️ One lock order everywhere: `pool_day` → `branch_capacity` → exclusion (iron rule 14).
⚠️ Availability and price are computed **here**, never in the client (rules 1, 2).

`make map` lists them all with their purpose and spec section — generated from the file
headers, so it cannot drift. `locate/find.sh <words>` finds one from a bug report.

The few worth knowing without looking:

| Module | Why it is special |
|---|---|
| `availability/availability` | the core; obligations vs physical stock are two different queries |
| `pricing/pricing` | rules engine; the result is a **snapshot**, never a reference to a rule |
| `core/order-lifecycle` | **the only** place order status changes |
| `orders/recalc` | early return — mandatory by Civil Code art. 630, never exceeds the original |
| `core/outbox` | external effects written inside the transaction, retried by a worker |

## Patterns

- **Signature:** `fn(c: PoolClient, input): Promise<Result>`. `c` first, always.
- **Errors:** throw via `server/utils/errors.ts` (`apiError`), map DB codes with
  `mapDbError` — `23P01` (exclusion) and `23505` (unique) are business outcomes, not 500s.
- **Money:** `numeric` in, strings out. Intermediate math in kopecks as integers
  (see `recalc.ts`), never float.
- **Time:** days come from `shared/day-count.ts` — three tenant modes give different
  totals on the same order. Never subtract timestamps by hand.
- **Tenant scope:** `withTenant(tenantId, fn)` from `server/utils/db.ts` sets
  `SET LOCAL app.tenant_id`. `withoutTenant` only for platform-level work.
