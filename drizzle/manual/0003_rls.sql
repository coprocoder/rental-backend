-- 0003_rls.sql — изоляция тенантов через Row Level Security, fail closed.
--
-- Железное правило №10: tenant_id + RLS, fail closed. SET LOCAL app.tenant_id
-- из сессии или ключа API, НИКОГДА из тела запроса — подмена одного поля
-- иначе даёт доступ к чужим данным (docs/10-бэкенд/17-доступ-и-роли.md).
--
-- Почему RLS, а не WHERE tenant_id = $1 в каждом запросе: WHERE можно забыть
-- в одном запросе из двадцати, и это не сломает тесты — просто вернёт лишние
-- строки. RLS забыть нельзя: движок фильтрует все запросы, включая те,
-- которые ещё не написаны, и те, что напишет ИИ-агент через полгода.
--
-- ⚠️ Идемпотентность: политики создаются через DROP POLICY IF EXISTS + CREATE.
-- CREATE POLICY IF NOT EXISTS не существует, а изменённое определение политики
-- при простом «создать, если нет» молча не применилось бы.

-- ============================================================================
-- Роль приложения
-- ============================================================================
--
-- ⚠️ САМАЯ ОПАСНАЯ ЛОВУШКА RLS: владелец таблицы её политики ОБХОДИТ, а
-- суперпользователь обходит RLS вообще всегда, даже FORCE.
-- В docker-compose POSTGRES_USER: rental — значит rental суперпользователь и
-- владелец схемы: под ним RLS не работает НИКАК, и тест изоляции пройдёт
-- «зелёным» на пустом месте.
--
-- Отсюда: приложение ходит под отдельной НЕ-суперпользовательской ролью
-- rental_app, а миграции — под владельцем. Это же даёт бесплатную защиту:
-- приложение не может ни DROP TABLE, ни ALTER ... DISABLE ROW LEVEL SECURITY.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rental_app') THEN
    -- Пароль не задаём: локально коннект по trust/через владельца,
    -- в проде роль создаётся отдельно с секретом из окружения.
    CREATE ROLE rental_app NOLOGIN NOSUPERUSER NOBYPASSRLS;
    RAISE NOTICE 'создана роль rental_app (NOLOGIN: пароль выдаётся отдельно)';
  END IF;
END
$$;

-- ⚠️ NOBYPASSRLS выставляем и существующей роли: если её создали раньше
-- руками, она могла получить BYPASSRLS и тихо обходить всю изоляцию.
ALTER ROLE rental_app NOSUPERUSER NOBYPASSRLS;

GRANT USAGE ON SCHEMA public TO rental_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO rental_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO rental_app;

-- Права на таблицы, которые появятся в следующих миграциях: иначе после
-- каждого db:generate придётся вручную догранчивать, и однажды забудут.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO rental_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO rental_app;

-- ============================================================================
-- Функция текущего тенанта — fail closed
-- ============================================================================
--
-- ⚠️ ЗДЕСЬ ЖИВЁТ «fail closed», и это тонкое место.
--
-- current_setting('app.tenant_id', true) — со вторым аргументом true
-- (missing_ok): если переменная не выставлена, возвращается NULL, а не
-- ошибка. Дальше сравнение tenant_id = NULL даёт NULL, а не TRUE —
-- политика не пропускает ни одной строки. То есть забытый
-- SET LOCAL app.tenant_id означает «не видно ничего», а НЕ «видно всё».
--
-- Это и есть fail closed, и именно так, а не наоборот:
--   * с missing_ok = false запрос без SET LOCAL падал бы с 42704 —
--     тоже безопасно, но каждый служебный запрос (миграции, health check,
--     фоновые задачи) требовал бы фиктивного тенанта;
--   * а вот политика вида «tenant_id = coalesce(setting, tenant_id)» или
--     «setting IS NULL OR tenant_id = setting» — это fail OPEN: забыл
--     выставить переменную → видно всю базу. Такой вариант выглядит
--     «удобнее» и его регулярно предлагают. Никогда так не делать.
--
-- STABLE, а не IMMUTABLE: значение зависит от настроек сессии.
-- PARALLEL RESTRICTED — current_setting в параллельных воркерах ненадёжен.
-- Тело обёрнуто в исключение: если в переменной лежит мусор (не uuid),
-- ::uuid бросил бы 22P02 и запрос упал бы вместо того, чтобы ничего не
-- показать. Мусор в app.tenant_id тоже должен означать «ничего не видно».
CREATE OR REPLACE FUNCTION app_current_tenant() RETURNS uuid
LANGUAGE plpgsql STABLE PARALLEL RESTRICTED
AS $$
DECLARE
  raw text := current_setting('app.tenant_id', true);
BEGIN
  IF raw IS NULL OR raw = '' THEN
    RETURN NULL;   -- fail closed: сравнение с NULL не пропустит ни строки
  END IF;
  RETURN raw::uuid;
EXCEPTION
  WHEN invalid_text_representation THEN
    RETURN NULL;   -- мусор в переменной = тоже «ничего не видно»
END
$$;

COMMENT ON FUNCTION app_current_tenant() IS
  'Текущий тенант из app.tenant_id. NULL, если не выставлен или невалиден — '
  'политики RLS при этом не пропускают ни одной строки (fail closed). '
  'Выставляется только SET LOCAL из сессии или ключа API, никогда из тела запроса.';

-- ============================================================================
-- Политики на всех таблицах с tenant_id
-- ============================================================================
--
-- Список таблиц не перечисляем руками, а находим по наличию колонки
-- tenant_id. Причина: таблиц около тридцати и их станет больше — забыть
-- одну при ручном перечислении вопрос времени, а забытая таблица это дыра
-- в изоляции, которую не видно ни в одном тесте, кроме теста на дрейф.
--
-- Что делает каждая строка цикла:
--   ENABLE ROW LEVEL SECURITY — включает проверку политик;
--   FORCE ROW LEVEL SECURITY — ⚠️ обязателен: без него ВЛАДЕЛЕЦ таблицы
--     политики обходит. Приложение под rental_app и так не владелец, но
--     миграции, сидинг и psql на стойке разработчика ходят под владельцем,
--     и без FORCE любой такой запрос видит всю базу. Хуже: тесты изоляции,
--     запущенные под владельцем, ложно зеленеют.
--   USING — какие строки видны на SELECT/UPDATE/DELETE;
--   WITH CHECK — какие строки разрешено записать. То же условие: без него
--     INSERT с чужим tenant_id пройдёт (USING на INSERT не проверяется),
--     то есть можно писать в чужого тенанта, не читая его. Это ровно тот
--     сценарий, который RLS должен закрывать.
--
-- Одна политика FOR ALL, а не четыре по командам: условие одно и то же,
-- а четыре политики = четыре места, где можно разойтись.
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'                    -- только обычные таблицы
      AND a.attname = 'tenant_id'
      AND a.attnum > 0
      AND NOT a.attisdropped
      AND c.relname <> '_manual_migrations'  -- журнал раннера, вне тенантов
    ORDER BY c.relname
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t.relname);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t.relname);

    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t.relname);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I
        FOR ALL
        USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
        WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid)
    $f$, t.relname);

    RAISE NOTICE 'RLS включён: %', t.relname;
  END LOOP;
END
$$;

-- ⚠️ Почему в самой политике current_setting(...)::uuid, а не
-- app_current_tenant(): планировщик подставляет current_setting как
-- стабильное выражение и использует индекс по tenant_id; вызов plpgsql-функции
-- в каждой политике на каждой строке заметно дороже на больших таблицах.
-- Функция app_current_tenant() остаётся для прикладного кода и тестов —
-- там важнее устойчивость к мусору, чем цена вызова.
--
-- Следствие: если в app.tenant_id положить не-uuid, запрос упадёт с 22P02.
-- Это не fail open — строк всё равно не видно, — но ошибка будет не той,
-- которую ждут. Отсюда правило: значение в SET LOCAL валидируется как uuid
-- ДО подстановки, на границе (см. слой валидации, docs/10-бэкенд/20-api.md).

-- ============================================================================
-- Индексы под RLS
-- ============================================================================
--
-- ⚠️ Условие политики добавляется к КАЖДОМУ запросу. Без индекса, начинающегося
-- с tenant_id, каждый такой запрос — seq scan по всем тенантам.
-- Одиночный индекс на tenant_id почти бесполезен (селективность низкая:
-- у крупного тенанта это половина таблицы), но он нужен как минимум
-- для планировщика на мелких таблицах-справочниках. Составные индексы
-- (tenant_id, ...) под конкретные запросы — задача этапа, где эти запросы
-- появятся; здесь только базовый минимум.
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND a.attname = 'tenant_id'
      AND a.attnum > 0
      AND NOT a.attisdropped
      AND c.relname <> '_manual_migrations'
  LOOP
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS %I ON %I (tenant_id)',
      t.relname || '_tenant_id_idx', t.relname
    );
  END LOOP;
END
$$;

-- ============================================================================
-- Проверка, что изоляция действительно включена
-- ============================================================================
--
-- Тест на дрейф схемы (test/invariants.test.ts) проверяет то же самое, но
-- здесь проверка стоит ноль и срабатывает в момент миграции: если Drizzle
-- добавил таблицу с tenant_id, а этот файл не перезапустили, миграция
-- скажет об этом сразу. Незакрытая таблица — дыра, которую иначе видно
-- только на проде и только по чужим данным в отчёте.
DO $$
DECLARE
  unprotected text[];
BEGIN
  SELECT array_agg(c.relname ORDER BY c.relname) INTO unprotected
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.oid
  WHERE n.nspname = 'public'
    AND c.relkind = 'r'
    AND a.attname = 'tenant_id'
    AND a.attnum > 0
    AND NOT a.attisdropped
    AND c.relname <> '_manual_migrations'
    AND NOT (c.relrowsecurity AND c.relforcerowsecurity);

  IF unprotected IS NOT NULL THEN
    RAISE EXCEPTION 'таблицы с tenant_id без RLS/FORCE: %', array_to_string(unprotected, ', ');
  END IF;
END
$$;
