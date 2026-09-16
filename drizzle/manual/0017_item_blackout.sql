-- Отключение КОНКРЕТНОЙ единицы на даты.
--
-- ⚠️ Отдельная таблица, а не колонка в variant_blackout: у отключения
-- позиции и отключения вещи разный смысл. «Сапборды не сдаём в ноябре»
-- — это про позицию целиком; «этот ботинок в ремонте до пятницы» — про
-- одну вещь, и остальные восемь пар обязаны продолжать продаваться.
-- Смешав их в одной таблице с nullable item_id, мы получили бы запрос
-- наличия, который должен различать NULL и значение в каждом условии —
-- и однажды перестанет.
--
-- ⚠️ Наличие при поимённом учёте считается как «сколько единиц НЕ
-- отключено и не занято», поэтому отключение вещи уменьшает ёмкость
-- на единицу, а не обнуляет пул (в отличие от variant_blackout).
CREATE TABLE IF NOT EXISTS item_blackout (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  item_id     uuid NOT NULL REFERENCES item(id),
  -- Полуоткрытый [from, to): «по 5 января» хранится как to = 6-е.
  days        daterange NOT NULL,
  reason      text NOT NULL,
  created_by  uuid REFERENCES staff(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS item_blackout_tenant_idx ON item_blackout (tenant_id);
CREATE INDEX IF NOT EXISTS item_blackout_item_idx ON item_blackout (item_id);

-- ⚠️ Тот же режим, что у остальных таблиц тенанта: fail closed.
-- Без этого отключения одного проката видны другому (железное правило 10).
ALTER TABLE item_blackout ENABLE ROW LEVEL SECURITY;
ALTER TABLE item_blackout FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON item_blackout;
CREATE POLICY tenant_isolation ON item_blackout
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON item_blackout TO rental_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON item_blackout TO rental_worker;
