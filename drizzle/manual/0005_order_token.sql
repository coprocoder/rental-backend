-- Токены доступа клиента к заказу.
--
-- Клиент не регистрируется: доступ даётся ссылкой из уведомления.
-- Требования — docs/10-бэкенд/17-доступ-и-роли.md.
--
-- ⚠️ Хранится хеш, а не токен: дамп базы не должен открывать чужие
-- заказы. Уникальность по хешу — это и индекс точки входа, и защита
-- от коллизий при генерации.
--
-- Идемпотентно.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'order_token_purpose') THEN
    CREATE TYPE order_token_purpose AS ENUM ('view', 'confirm', 'cancel');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS order_token (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant (id),
  order_id    uuid NOT NULL REFERENCES rental_order (id),
  purpose     order_token_purpose NOT NULL,
  token_hash  text NOT NULL,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'order_token_hash_uk') THEN
    ALTER TABLE order_token ADD CONSTRAINT order_token_hash_uk UNIQUE (token_hash);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS order_token_order_idx ON order_token (order_id, purpose);

-- ⚠️ RLS обязательна и здесь: без неё токен одного тенанта нашёлся бы
-- в контексте другого. FORCE — чтобы владелец таблицы не был исключением.
ALTER TABLE order_token ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_token FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'order_token' AND policyname = 'order_token_tenant_isolation'
  ) THEN
    CREATE POLICY order_token_tenant_isolation ON order_token
      USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
      WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
  END IF;
END $$;
