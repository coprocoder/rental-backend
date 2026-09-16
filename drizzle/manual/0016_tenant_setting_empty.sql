-- 0016_tenant_setting_empty.sql — пустой app.tenant_id больше не роняет запрос.
--
-- ⚠️ ДЕФЕКТ, ради которого миграция: `SET LOCAL app.tenant_id` после
-- COMMIT сбрасывается НЕ в NULL, а в ПУСТУЮ СТРОКУ. Соединение уходит
-- обратно в пул с `app.tenant_id = ''`, и следующий запрос на нём,
-- идущий без тенантного контекста (разбор клиентского токена —
-- единственный законный случай), попадает на политику
-- `tenant_id = current_setting('app.tenant_id', true)::uuid`.
-- Приведение '' к uuid не возвращает пусто, а БРОСАЕТ ошибку:
--   invalid input syntax for type uuid: ""
-- Клиент видел 500 и «Ссылка не открылась» на своей же ссылке из письма.
--
-- ⚠️ Почему не воспроизводилось локально: на машине разработчика
-- приложение ходит под владельцем БД, а владелец политики ОБХОДИТ —
-- ни одна из них не вычисляется. Разница между dev и продом была не
-- в коде, а в РОЛИ. Тот же класс ошибки уже ломал витрину (см.
-- комментарий к queryNoTenant в server/utils/db.ts).
--
-- ⚠️ Чинится ОДНОЙ функцией, а не правкой 36 политик по отдельности:
-- иначе следующая добавленная политика повторит приведение, и дефект
-- вернётся. `app_tenant_id()` — единственное место, где строка
-- превращается в uuid.

-- STABLE: значение не меняется внутри запроса, планировщик может
-- вычислить один раз. Не IMMUTABLE — зависит от настройки сессии.
CREATE OR REPLACE FUNCTION app_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$
    SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
  $$;

COMMENT ON FUNCTION app_tenant_id() IS
  'Текущий тенант из app.tenant_id. Пустая строка (сброс SET LOCAL после '
  'COMMIT) и незаданное значение дают NULL, а не ошибку приведения к uuid.';

-- ⚠️ NULL сравнивается через IS NOT DISTINCT FROM? Нет: сравнение
-- `tenant_id = NULL` даёт NULL, то есть строка НЕ проходит политику.
-- Это и нужно — fail closed: нет тенанта, нет доступа. Важно лишь,
-- что теперь это отказ, а не исключение.

-- Переписываем все политики, приводящие app.tenant_id к uuid, на функцию.
-- Делается запросом по каталогу, а не списком имён: политик 36, и
-- забытая означала бы, что дефект остался ровно в ней.
DO $$
DECLARE
  p RECORD;
  new_qual text;
  new_check text;
  cmd text;
BEGIN
  FOR p IN
    SELECT c.relname AS tbl,
           pol.polname AS name,
           pg_get_expr(pol.polqual, pol.polrelid) AS qual,
           pg_get_expr(pol.polwithcheck, pol.polrelid) AS wcheck,
           CASE pol.polcmd
             WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT'
             WHEN 'w' THEN 'UPDATE' WHEN 'd' THEN 'DELETE'
             ELSE 'ALL' END AS cmd,
           -- ⚠️ polroles = {0} означает PUBLIC, и pg_get_userbyid(0)
           -- возвращает «unknown (OID=0)» — имя, которого нет. Роли
           -- собираем явно, отбрасывая 0.
           (SELECT array_agg(quote_ident(pg_get_userbyid(r)))
              FROM unnest(pol.polroles) AS r
             WHERE r <> 0) AS role_names
    FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    WHERE pg_get_expr(pol.polqual, pol.polrelid) LIKE '%app.tenant_id%::uuid%'
       OR pg_get_expr(pol.polwithcheck, pol.polrelid) LIKE '%app.tenant_id%::uuid%'
  LOOP
    new_qual := replace(
      p.qual,
      '(current_setting(''app.tenant_id''::text, true))::uuid',
      'app_tenant_id()');
    new_check := replace(
      coalesce(p.wcheck, ''),
      '(current_setting(''app.tenant_id''::text, true))::uuid',
      'app_tenant_id()');

    cmd := format('DROP POLICY IF EXISTS %I ON %I', p.name, p.tbl);
    EXECUTE cmd;

    cmd := format('CREATE POLICY %I ON %I FOR %s', p.name, p.tbl, p.cmd);
    -- Роли политики сохраняем: часть из них выдана только rental_app.
    -- Пустой список значит PUBLIC — тогда TO не пишем вовсе.
    IF p.role_names IS NOT NULL AND array_length(p.role_names, 1) > 0 THEN
      cmd := cmd || ' TO ' || array_to_string(p.role_names, ', ');
    END IF;
    IF new_qual IS NOT NULL AND new_qual <> '' THEN
      cmd := cmd || format(' USING (%s)', new_qual);
    END IF;
    IF new_check <> '' THEN
      cmd := cmd || format(' WITH CHECK (%s)', new_check);
    END IF;

    EXECUTE cmd;
    RAISE NOTICE 'политика % на % переведена на app_tenant_id()', p.name, p.tbl;
  END LOOP;
END
$$;

GRANT EXECUTE ON FUNCTION app_tenant_id() TO rental_app;
