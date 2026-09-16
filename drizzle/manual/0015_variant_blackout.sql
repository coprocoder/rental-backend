-- Точечное отключение позиции на даты (18.2).
--
-- Прямая жалоба на Twice Commerce из разбора конкурентов: «невозможно
-- полностью отключить товар на определённые дни». Существующие
-- механизмы этого не закрывают, и подменять их нельзя:
--
--   category.season_*   про КАТЕГОРИЮ и про КАЖДЫЙ год (сноуборды зимой);
--   schedule            про ФИЛИАЛ целиком (31 декабря закрыты);
--   pool_day.capacity   про то, сколько физически ЕСТЬ.
--
-- Нужен четвёртый случай: один вариант не продаётся с 3 по 5 января,
-- потому что уехал на выставку или лежит в ремонте.
--
-- ⚠️ Отдельная таблица, а не обнуление pool_day.capacity. Ёмкость —
-- это «сколько есть», отключение — «не продавать». Занулив ёмкость,
-- мы потеряли бы исходное число и не смогли корректно снять отключение;
-- хуже того, в эти дни могут уже стоять брони, и их qty_booked обязан
-- сохраниться.
--
-- ⚠️ Диапазон, а не строка на каждый день: «до пятницы» — это одна
-- запись, и снимается она одним действием. daterange полуоткрытый
-- [from, to) — как все интервалы в проекте (железное правило 4).
--
-- Идемпотентно.

CREATE TABLE IF NOT EXISTS variant_blackout (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  variant_id  uuid NOT NULL REFERENCES inventory_variant(id),
  -- Полуоткрытый интервал дней: [from, to).
  days        daterange NOT NULL,
  -- ⚠️ Причина обязательна: отключение видно клиенту как «нет мест»,
  -- и через месяц никто не вспомнит, почему позиция выпала. Железное
  -- правило 13 — у каждого действия есть автор и причина.
  reason      text NOT NULL,
  created_by  uuid REFERENCES staff(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS variant_blackout_lookup_idx
  ON variant_blackout USING gist (variant_id, days);

CREATE INDEX IF NOT EXISTS variant_blackout_tenant_idx
  ON variant_blackout (tenant_id);

-- ── RLS: как на всех таблицах с tenant_id, fail closed ────────────────
ALTER TABLE variant_blackout ENABLE ROW LEVEL SECURITY;
ALTER TABLE variant_blackout FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'variant_blackout' AND policyname = 'variant_blackout_tenant_isolation'
  ) THEN
    CREATE POLICY variant_blackout_tenant_isolation ON variant_blackout
      USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
      WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
  END IF;
END $$;
