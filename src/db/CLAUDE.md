# server/db — the schema

One file: `schema.ts`, ~940 lines, 41 tables. Drizzle definitions only — tables, types,
indexes.

⚠️ **The invariants are not here.** `EXCLUDE USING GIST`, `CHECK`, RLS policies and the
functions behind them live in `drizzle/manual/*.sql`, because an ORM cannot express them.
Reading `schema.ts` alone tells you the shape of the data and nothing about what the
database will refuse — and refusing is the point (iron rule 2). See `drizzle/CLAUDE.md`.

⚠️ **`schema.ts` is imported by nobody.** `drizzle-kit generate` reads it to diff against
migrations; application code writes SQL by hand through `server/gateway` and
`server/domain`. It is an orphan by design, and `dependency-cruiser` excludes it
explicitly.

## The 41 tables, by what they are for

| Area | Tables |
|---|---|
| platform | `plan`, `tenant`, `api_key`, `tenant_text`, `tenant_flag` |
| places & people | `branch`, `staff`, `shift`, `staff_session`, `staff_login_attempt` |
| what is rented | `category`, `inventory_variant`, `item`, `set_template` |
| stock & availability | `pool_day`, `movement`, `branch_capacity`, `branch_capacity_day`, `branch_offline_reserve`, `item_blackout`, `variant_blackout` |
| rules | `schedule`, `fit_rule`, `price_rule`, `booking_limit` |
| orders | `customer`, `rental_order`, `order_line`, `order_token`, `waitlist` |
| money | `payment`, `receipt`, `deposit` |
| paper | `agreement`, `consent`, `file` |
| mechanics | `event`, `outbox`, `audit_log`, `demand_daily` |

## Four decisions you will meet immediately

**`rental_order`, not `order`** — `order` is a reserved SQL word, and quoting it forever is
worse than naming it properly once.

**`pool_day` is a per-day counter, not a sum.** Availability for a pooled category is
computed day by day or by sweep-line, **never** with a naive `SUM` over intersecting
bookings: bookings on the 3rd and the 10th both intersect "1–15" but never coexist, and a
`SUM` overstates demand (iron rule 5). It is also the busiest row in the system — the
contention point that matters under load, not CPU.

**Archive, never delete.** `archived_at` instead of `DELETE` wherever rows are referenced:
`movement` and `order_line` point at items, and stock is the sum of movements. A deleted
row does not just vanish — it rewrites history.

**Money is `numeric`; intervals are `tstzrange`, half-open `[from, to)`.** A prep buffer
widens the range; it never changes the operator. Floats and inclusive ranges are how cents
and midnights disappear.

## Tests

`server/db/test/` holds the schema-level tests — RLS isolation, EXCLUDE behaviour, season
logic, drift against `pg_constraint`. They are not about any one module, which is why they
live here rather than beside a domain file. See that directory's own CLAUDE.md.

⚠️ They run against a **real Postgres**. `EXCLUDE USING GIST` and RLS do not exist in
emulators, and a test that "passes" without them proves nothing.

⚠️ A test of tenant isolation run as the **schema owner** is meaningless — the owner
bypasses RLS (that is what `FORCE ROW LEVEL SECURITY` exists to stop), so it goes green on
a wide-open database. The suite connects as the owner but switches inside the transaction:

```sql
SET LOCAL ROLE rental_app    -- see invariants.test.ts
```

`SET LOCAL`, so the role reverts on rollback and does not leak into the next test. **Any
new test that claims to prove isolation must do the same** — otherwise it proves that the
owner can read everything, which was never in doubt.
