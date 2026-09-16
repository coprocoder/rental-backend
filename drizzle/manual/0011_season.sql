-- Сезонность категории и период работы филиала — месяцами.
--
-- ⚠️ До этой миграции сезонность в системе не была выражена ничем:
-- каталог в сентябре предлагал сноуборды и сапборды разом, отчёт
-- упущенного спроса смешивал летние отказы по зимнему товару с зимними,
-- загрузка сапбордов зимой считалась 0% при существующей ёмкости, а
-- заказ «сноуборд + сапборд на 15 января» проходил без проверок.
--
-- Месяцы, не даты: сезон повторяется ежегодно. Зима 11→4 переходит
-- через Новый год — нормальный случай, а не крайний.
--
-- Две ОТДЕЛЬНЫЕ оси: сезон категории (сапборды летом при работающем
-- зимой филиале) и период филиала (зимний прокат летом закрыт целиком).
--
-- Идемпотентно.

ALTER TABLE category ADD COLUMN IF NOT EXISTS season_from_month integer;
ALTER TABLE category ADD COLUMN IF NOT EXISTS season_to_month   integer;
ALTER TABLE branch   ADD COLUMN IF NOT EXISTS season_from_month integer;
ALTER TABLE branch   ADD COLUMN IF NOT EXISTS season_to_month   integer;

-- Границы месяцев — инвариант в БД, а не в коде: 13-й месяц в форме
-- админки не должен молча закрывать категорию навсегда.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'category_season_months_ck') THEN
    ALTER TABLE category ADD CONSTRAINT category_season_months_ck CHECK (
      (season_from_month IS NULL OR season_from_month BETWEEN 1 AND 12) AND
      (season_to_month   IS NULL OR season_to_month   BETWEEN 1 AND 12)
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'branch_season_months_ck') THEN
    ALTER TABLE branch ADD CONSTRAINT branch_season_months_ck CHECK (
      (season_from_month IS NULL OR season_from_month BETWEEN 1 AND 12) AND
      (season_to_month   IS NULL OR season_to_month   BETWEEN 1 AND 12)
    );
  END IF;
END $$;

-- SQL-двойник shared/season.ts#monthInSeason. Нужен отчётам: загрузка
-- считается только по дням в сезоне, иначе сапборды зимой дают 0% и
-- отчёт советует «продать часть». Тест проверяет согласие с TS-версией
-- на всех 12×12×12 комбинациях.
--
-- Оба NULL — круглый год; один NULL — тоже: половина границы
-- бессмысленна, и закрывать категорию из-за недозаполненной формы
-- нельзя — система работает при небрежном заполнении данных.
CREATE OR REPLACE FUNCTION season_month_active(m integer, f integer, t integer)
RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN f IS NULL OR t IS NULL THEN true
    WHEN f <= t THEN m BETWEEN f AND t
    ELSE m >= f OR m <= t
  END
$$;

COMMENT ON FUNCTION season_month_active(integer, integer, integer) IS
  'Активен ли месяц m в сезоне f→t включительно, с переходом через Новый год. '
  'Двойник shared/season.ts#monthInSeason — при изменении менять оба.';
