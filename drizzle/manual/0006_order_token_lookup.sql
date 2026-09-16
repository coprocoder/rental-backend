-- Поиск заказа по токену клиента.
--
-- Проблема: тенант определяется САМИМ токеном, то есть до его разбора
-- выставить app.tenant_id нечем. А FORCE RLS применяется и к владельцу
-- таблицы, поэтому запрос без контекста возвращает ноль строк —
-- правильное fail-closed поведение, из-за которого ссылка не работает.
--
-- Решение: отдельная роль для поиска по токену, у которой есть политика
-- «видно строку, если знаешь её token_hash». Знание 256-битного хеша и
-- есть аутентификация — угадать его нельзя, а перебор упирается в
-- уникальный индекс и rate limiting.
--
-- ⚠️ Роль намеренно НЕ получает BYPASSRLS: она видит только order_token
-- и только по точному совпадению хеша, а не таблицу целиком. Данные
-- заказа читаются уже в тенантном контексте, установленном по найденному
-- tenant_id.
--
-- Идемпотентно.

-- Политика поиска: строку видно, только если хеш назван явно.
-- current_setting('app.token_hash') выставляется на время запроса.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'order_token' AND policyname = 'order_token_lookup_by_hash'
  ) THEN
    CREATE POLICY order_token_lookup_by_hash ON order_token
      FOR SELECT
      USING (token_hash = current_setting('app.token_hash', true));
  END IF;
END $$;

COMMENT ON POLICY order_token_lookup_by_hash ON order_token IS
  'Поиск по токену клиента: тенант определяется токеном, поэтому '
  'app.tenant_id на этот запрос ещё неизвестен. Знание хеша = аутентификация.';
