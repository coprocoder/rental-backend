#!/usr/bin/env bash
# Снятие эталона ответов API.
#
# ⚠️ Раскладка по КОНТУРАМ (`baseline/{public,staff,admin,counter}/`), а не
# плоским списком: 38 файлов в одной директории не читаются, а по контурам
# сразу видно, что покрыто и чего не хватает.
#
# ⚠️ ПЕРЕЕЗД ЗАВЕРШЁН (16 сентября 2026): Nuxt-бэкенда больше нет,
# эталон снимается с этого сервиса (:3200). Свою задачу — доказать, что
# перенос ничего не сломал, — он выполнил: 38 из 38 совпали побайтово
# на каждом шаге.
#
# ⚠️ Сам эталон переехал сюда из фронта 18 сентября 2026. Читали его
# только здешние проверки (`make baseline`, тест OpenAPI) — по пути
# `../rental/test/api/baseline`, то есть граница репозиториев проходила
# посередине проверки. Во фронте рядом лежала ВТОРАЯ копия, слепок
# старого Nuxt-стенда со стеками `/app/server/...`: её не читал никто,
# и она молча расходилась с живой по 20 файлам.
#
# Теперь это регрессионный слепок: он ловит непреднамеренные изменения
# ответов при доработках. ⚠️ Пересоздавать его ОСОЗНАННО, объясняя в
# коммите, что и почему изменилось — иначе он согласится с любым
# свежим дефектом.
#
#   make dev                               # API на :3200
#   ./test/fixtures/capture-baseline.sh
#
# Сверка: make baseline
#
# ⚠️ Часть ответов ЗАВИСИТ ОТ «СЕГОДНЯ»: admin/service считает days —
# сколько дней вещь в ремонте, admin/today и admin/plan тоже смотрят на
# текущую дату. Эталон, снятый вчера, разойдётся с сегодняшним ответом
# на этих полях, и это НЕ дефект переезда.
#
# Проверять так: если расхождение только во «временны́х» полях —
# сравнить ОБА бэкенда между собой напрямую. Совпали — пересобрать
# эталон. Разошлись — вот это уже находка.
set -u
B=${API:-http://localhost:3200}/api/v1
OUT="$(dirname "$0")/baseline"
CJ=$(mktemp)
curl -s -c "$CJ" -X POST "${API:-http://localhost:3200}/api/v1/staff/login" \
  -H 'content-type: application/json' \
  -d '{"email":"owner@demo.local","password":"demo1234"}' -o /dev/null
TID=$(docker exec rental-postgres-1 psql -U rental -d rental -tA -c "SELECT id FROM tenant WHERE slug='demo'")
OID=$(docker exec rental-postgres-1 psql -U rental -d rental -tA -c "SELECT id FROM rental_order WHERE tenant_id='$TID' ORDER BY created_at LIMIT 1")
TOK=$(docker exec rental-postgres-1 psql -U rental -d rental -tA -c "SELECT token FROM order_token WHERE tenant_id='$TID' AND purpose='view' LIMIT 1")
echo "order=$OID token=${TOK:0:8}…"

# ⚠️ Рядом с эталонами пишется карта «имя → запрос». Без неё сверка
# вынуждена угадывать URL по имени файла, а угадывание ломается на
# первом же эндпоинте с двумя параметрами.
URLS="$OUT/urls.json"
: > "$URLS.tmp"

grab() { # name url [auth]   name = <контур>_<ресурс>[__<вариант>]
  local name="$1" url="$2" auth="${3:-}"
  local contour="${name%%_*}" rest="${name#*_}"
  mkdir -p "$OUT/$contour"
  local f="$OUT/$contour/$rest.json" code
  printf '%s\t%s\n' "$contour/$rest" "${url#${API:-http://localhost:3200}}" >> "$URLS.tmp"
  if [ "$auth" = "auth" ]; then
    code=$(curl -s -b "$CJ" -o "$f" -w '%{http_code}' "$url")
  else
    code=$(curl -s -o "$f" -w '%{http_code}' "$url")
  fi
  printf "  %-34s %s  %s байт\n" "$name" "$code" "$(wc -c < "$f")"
}

echo "— публичные —"
grab public_catalog                 "$B/public/catalog?tenant=demo"
grab public_catalog__locale_en      "$B/public/catalog?tenant=demo&locale=en"
grab public_catalog__summer         "$B/public/catalog?tenant=demo&from=2027-07-15"
grab public_agreement_offer         "$B/public/agreement/offer?tenant=demo"
[ -n "$TOK" ] && grab public_order_by_token "$B/public/orders/$TOK"

echo "— сотрудник —"
grab staff_me                       "$B/staff/me" auth

echo "— админка —"
for r in blackout branches fit-rules flags integrations inventory items lost-demand \
         offline-reserve orders plan pricing reports service setup staff texts theme today waitlist; do
  grab "admin_$r" "$B/admin/$r" auth
done
[ -n "$OID" ] && { grab admin_order_by_id "$B/admin/orders/$OID" auth; grab admin_order_timeline "$B/admin/orders/$OID/timeline" auth; }

echo "— стойка —"
for r in catalog free-items history item-lookup orders shift upsell; do
  grab "counter_$r" "$B/counter/$r" auth
done

# ⚠️ Эндпоинты, требующие параметр, снимаются ДВАЖДЫ: без него (отказ
# валидации — тоже контракт, виджет реагирует на код) и с ним.
VID=$(docker exec rental-postgres-1 psql -U rental -d rental -tA -c \
  "SELECT id FROM inventory_variant WHERE tenant_id='$TID' AND archived_at IS NULL ORDER BY code LIMIT 1")

echo "— с параметрами —"
grab admin_blackout__variant      "$B/admin/blackout?variantId=$VID" auth
grab counter_free-items__variant  "$B/counter/free-items?variantId=$VID" auth
[ -n "$OID" ] && {
  grab counter_history__order "$B/counter/history?orderId=$OID" auth
  grab counter_upsell__order  "$B/counter/upsell?orderId=$OID" auth
}

python3 - "$URLS.tmp" "$URLS" <<'PYEOF'
import json, sys
rows = [l.rstrip('\n').split('\t') for l in open(sys.argv[1]) if l.strip()]
json.dump(dict(rows), open(sys.argv[2], 'w'), ensure_ascii=False, indent=2, sort_keys=True)
PYEOF
rm -f "$URLS.tmp"
echo "карта запросов: $URLS"
