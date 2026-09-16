---
name: verify
description: Run the backend checks in the right order. Use before committing, after any code change, or when asked to verify that everything passes.
---

# verify

```bash
make check          # всё: типы, тесты, границы слоёв
make typecheck      # по одному
make test
make arch
```

## Порядок и почему

Дёшево → дорого, чтобы падать раньше:

| Шаг | Ловит | Секунды |
|---|---|---|
| `typecheck` | опечатки, несовпадение типов | ~5 |
| `test` | поведение | ~1 |
| `arch` | нарушенные границы слоёв и модулей | ~10 |

⚠️ **`arch` нельзя пропускать** «потому что я только переименовал файл». Именно
переименование и ломает границы: импорт в обход фасада выглядит как обычная строка.

## Нужен Postgres

Тесты домена и транспорта идут без базы. Тесты слоя `database` требуют настоящий
Postgres — `EXCLUDE USING GIST` и RLS в эмуляторах не существуют, и тест, проходящий без
них, не доказывает ничего.

```bash
cd ../rental && docker compose up -d postgres    # порт 55432
```

⚠️ **Схема и миграции — в `../rental/`**, сюда не дублируются. Одна из копий стала бы
ложью в первый же день.

## Сверка с эталоном

Для переехавших эндпоинтов проверка не заканчивается тестами: ответ сверяется с эталоном,
снятым с Nuxt-стенда **до** переезда.

```bash
cd ../rental && docker compose up -d            # старый стенд на 3100
cd ../rental-backend && make dev                 # новый на 3200

curl -s 'http://localhost:3200/api/v1/public/catalog?tenant=demo' > /tmp/new.json
diff <(python3 -m json.tool --sort-keys ../rental/baseline/public_catalog_tenant_demo.json) \
     <(python3 -m json.tool --sort-keys /tmp/new.json)
```

⚠️ Сравнивать **разобранным JSON с сортировкой ключей**, а не строкой: порядок ключей в
объекте не часть контракта.

⚠️ Расхождение — это **находка, а не помеха**. Так был найден дефект 19.38: `SELECT
DISTINCT` без `ORDER BY` возвращал сезоны в порядке, зависящем от плана выполнения.
