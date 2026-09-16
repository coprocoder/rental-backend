# test — 189 tests, server on a real Postgres

⚠️ **Здесь остались только `setup.ts` и `manual/`.** Сами тесты переехали к коду,
который проверяют: `server/domain/<область>/test/`, `server/db/test/` (инварианты
схемы — они не про модуль, а про БД), `server/utils/test/`, `shared/test/`,
`app/**/test/`. Глоб в `vitest.workspace.ts` — `server/**` и `shared/**`.

⚠️ **A real database, not an emulator.** `EXCLUDE USING GIST` and RLS are exactly what
`pg-mem` and friends cannot do — and exactly what most needs testing. Tests run
**inside the container** (`npm test`); on the host `DATABASE_URL_TEST` is not set.

## Isolation

`inRollback(fn)` from `server/db/test/setup.ts` runs the body in a transaction and always rolls back.
No cleanup, no leakage between tests. `pool()` is a function, not a `let`, so reading it
before `beforeAll` fails loudly instead of looking like a driver error.

`fileParallelism: false` in `vitest.config.ts` — files share one database, so they must not
run concurrently.

## ⚠️ Race conditions need real connections

`inRollback` **cannot test a race**: one transaction never contends with itself, and a test
written that way passes even when the invariant is broken.

For concurrency use `pool().connect()` twice, drive both connections explicitly, and clean
up leaf-to-root by hand (foreign keys do not cascade). Wrap cleanup in `try/catch` and add
an `afterAll` sweep — an aborted race test otherwise leaves tenants behind in the demo data.
That has happened; three stray test tenants had to be removed by hand.

## What is covered

Invariants (`invariants.test.ts`) — double booking raises `23P01`, return-at-15:00 does not
collide with handover-at-15:00, a cancelled booking frees stock, RLS blocks cross-tenant
reads, and `pg_constraint` still lists every `EXCLUDE` (the drift test behind iron rule 11).

Domain logic — pricing, day counting in all three tenant modes, DIN, fit rules, recalc,
schedule, seasons, waitlist, upsell, limits, CSV, contrast, i18n fields.

## Two projects, not one

`vitest.workspace.ts` defines **server** (`environment: 'node'`, real Postgres, files run
serially) and **app** (`environment: 'happy-dom'`, `app/**/*.test.ts`).

⚠️ **Never switch the global environment.** `happy-dom` replaces globals the `pg` driver
relies on — that is why these are separate projects rather than one config.

⚠️ **The client needs its own tests.** 151 server tests were green while the booking form
was broken on the live stack: nine defects in `BookingForm.vue` survived a full sweep
because nothing mounted it. Component tests assert through the DOM and through **what goes
to the server**, never through component internals — `<script setup>` does not expose them,
and a test that reaches inside breaks on every rename.

⚠️ **No Nuxt auto-imports under vitest.** Components and composables must be imported
explicitly in the component's own `<script setup>`, or mounting fails with
`useX is not defined` while the real app works. The test must mount what the app runs.

⚠️ `BookingForm` calls `await useFetch` at the top level of setup, i.e. it is an async
component: mount it inside a `<Suspense>` boundary or Vue renders nothing at all, and every
assertion lies about why it failed.

## Writing a test

- Fixtures must mirror real data. An upsell fixture that put every extra in **one** category
  broke four tests when a one-per-category rule landed — the fixture was wrong, not the rule.
- When a test disagrees with the code, decide which is wrong before editing either. A 2-day
  window shifted by −1 day still overlaps the original: the expectation was wrong there,
  not the algorithm.
- Categories, enums and codes come from the seed, not from imagination:
  `tracking_mode` is `count|instance|labeled`, and the demo tenant's board category is
  `snowboard`, not `board`.
