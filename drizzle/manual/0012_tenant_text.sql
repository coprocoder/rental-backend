-- Тексты тенанта с версионированием (13.14).
--
-- ⚠️ До этой миграции оферта и политика ПД лежали в tenant.theme одной
-- строкой без истории. Это ломало главное свойство подписи: клиент
-- подписывает КОНКРЕТНУЮ редакцию, её хеш пишется в agreement, — и если
-- прокат правит текст поверх, восстановить, что именно человек подписал
-- в январе, становится нечем. Спор о повреждении разбирается через год,
-- и «текст с тех пор изменился» превращает подпись в ничто.
--
-- ⚠️ Поэтому редакции ДОБАВЛЯЮТСЯ, а не заменяются, и старые не
-- удаляются никогда: на них ссылаются подписанные договоры.
--
-- Ответственность за содержание — тенанта, платформа даёт заготовку
-- (docs/00-общее/04-правовое.md).
--
-- Идемпотентно.

CREATE TABLE IF NOT EXISTS tenant_text (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenant(id),
  -- Вид текста: оферта, политика обработки ПД, правила проката.
  kind       text NOT NULL,
  -- Номер редакции внутри вида, растёт на единицу.
  version    integer NOT NULL,
  body       text NOT NULL,
  -- ⚠️ Хеш считается от ТОГО ЖЕ текста, что показан клиенту, и хранится
  -- рядом: если показывать одно, а хешировать другое, подпись ничего
  -- не доказывает.
  hash       text NOT NULL,
  -- ⚠️ Действующая редакция ровно одна на вид — частичным уникальным
  -- индексом ниже, а не проверкой в коде: две действующие оферты
  -- означают, что неизвестно, какую подписал клиент.
  is_active  boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES staff(id),
  CONSTRAINT tenant_text_kind_ck CHECK (kind IN ('offer', 'privacy', 'rules')),
  CONSTRAINT tenant_text_version_ck CHECK (version >= 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS tenant_text_version_uq
  ON tenant_text (tenant_id, kind, version);

-- Действующая редакция одна на вид: инвариант в БД (железное правило №2).
CREATE UNIQUE INDEX IF NOT EXISTS tenant_text_active_uq
  ON tenant_text (tenant_id, kind) WHERE is_active;

CREATE INDEX IF NOT EXISTS tenant_text_lookup
  ON tenant_text (tenant_id, kind, created_at DESC);

-- RLS: тексты принадлежат тенанту, как и всё остальное. Fail closed.
ALTER TABLE tenant_text ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_text FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'tenant_text' AND policyname = 'tenant_text_isolation'
  ) THEN
    CREATE POLICY tenant_text_isolation ON tenant_text
      USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
      WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE ON tenant_text TO rental_app;
GRANT SELECT ON tenant_text TO rental_worker;

COMMENT ON TABLE tenant_text IS
  'Оферта, политика ПД и правила проката с историей редакций. '
  'Старые редакции не удаляются: на них ссылаются подписанные договоры '
  'через agreement.offer_version и offer_hash.';
