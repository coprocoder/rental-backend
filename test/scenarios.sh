#!/usr/bin/env bash
# Сценарные проверки мутаций: переход СОСТОЯНИЯ, а не форма одного ответа.
#
# ⚠️ Почему не эталон, как у GET. Мутация меняет состояние, и одиночный
# вызов о ней ничего не говорит: «создал → получил 200» проходит и на
# сломанном коде. Дефект замены будущей цены (19.23) нашёлся именно
# сценарием: create → replace → archive, где падал второй шаг.
#
#   ./test/scenarios.sh http://localhost:3200
set -u
B="${1:-http://localhost:3200}/api/v1"
CJ=$(mktemp)
PASS=0; FAIL=0

login() {
  curl -s -c "$CJ" -X POST "$B/staff/login" -H 'content-type: application/json' \
    -d '{"email":"owner@demo.local","password":"demo1234"}' -o /dev/null
  grep -q rental_session "$CJ" || { echo "✗ вход не удался"; exit 1; }
}

# check <имя> <ожидаемый-код> <метод> <путь> [тело]
check() {
  local name="$1" want="$2" method="$3" path="$4" body="${5:-}" got
  if [ -n "$body" ]; then
    got=$(curl -s -b "$CJ" -o /tmp/sc.json -w '%{http_code}' -X "$method" "$B$path" \
      -H 'content-type: application/json' -d "$body")
  else
    got=$(curl -s -b "$CJ" -o /tmp/sc.json -w '%{http_code}' -X "$method" "$B$path")
  fi
  if [ "$got" = "$want" ]; then
    printf '  ✓ %-46s %s\n' "$name" "$got"; PASS=$((PASS+1))
  else
    printf '  ✗ %-46s ожидали %s, получили %s\n' "$name" "$want" "$got"
    head -c 200 /tmp/sc.json; echo; FAIL=$((FAIL+1))
  fi
}

# Идентификаторы берём из БД: сценарий должен работать на любых демо-данных.
q() { docker exec rental-postgres-1 psql -U rental -d rental -tA -c "$1"; }
TID=$(q "SELECT id FROM tenant WHERE slug='demo'")
BID=$(q "SELECT id FROM branch WHERE tenant_id='$TID' ORDER BY name LIMIT 1")
VID=$(q "SELECT id FROM inventory_variant WHERE tenant_id='$TID' AND archived_at IS NULL ORDER BY code LIMIT 1")

login
echo "— расчёт цены (публичный, без входа) —"
FROM=$(date -u -d '+2 days' +%Y-%m-%dT10:00:00Z)
TO=$(date -u -d '+4 days' +%Y-%m-%dT10:00:00Z)
check "quote: расчёт по позиции"            200 POST /public/quote \
  "{\"tenant\":\"demo\",\"branchId\":\"$BID\",\"from\":\"$FROM\",\"to\":\"$TO\",\"lines\":[{\"variantId\":\"$VID\",\"qty\":1}]}"
check "quote: без tenant — отказ валидации"  422 POST /public/quote '{"lines":[]}'

echo "— цены: create → replace → archive (дефект 19.23) —"
# ⚠️ Дата берётся ПОСЛЕ конца действующего правила, и уникальная на
# прогон. Правила цен не пересекаются по времени (EXCLUDE): дата внутри
# существующего интервала упёрлась бы в инвариант, а не в проверяемую
# логику, а повтор той же даты — в само себя. Сценарий обязан быть
# перезапускаемым.
END=$(q "SELECT COALESCE(max(upper(valid))::date, current_date) FROM price_rule
         WHERE variant_id='$VID' AND archived_at IS NULL")
FUT=$(date -u -d "$END +$((1 + RANDOM % 500)) days" +%Y-%m-%d)
check "price: завести правило на будущее"   200 POST /admin/price-rules \
  "{\"action\":\"create\",\"variantId\":\"$VID\",\"ruleKind\":\"base\",\"amount\":\"1234.00\",\"validFrom\":\"${FUT}T00:00:00Z\"}"
RID=$(q "SELECT id FROM price_rule WHERE tenant_id='$TID' AND amount='1234.00' AND archived_at IS NULL AND lower(valid)::date = '$FUT' LIMIT 1")
if [ -n "$RID" ]; then
  # ⚠️ Именно этот шаг падал: закрытие старого правила тем же моментом
  # давало пустой tstzrange, CHECK отклонял, и прокат видел сообщение
  # про склад на экране про деньги (19.23).
  check "price: ЗАМЕНИТЬ будущее правило"    200 POST /admin/price-rules \
    "{\"action\":\"replace\",\"ruleId\":\"$RID\",\"amount\":\"1555.00\"}"
  RID2=$(q "SELECT id FROM price_rule WHERE tenant_id='$TID' AND amount='1555.00' AND archived_at IS NULL LIMIT 1")
  [ -n "$RID2" ] && check "price: архивировать" 200 POST /admin/price-rules \
    "{\"action\":\"archive\",\"ruleId\":\"$RID2\"}"
else
  echo "  ? правило не найдено — пропуск замены"
fi

echo "— рубильники: выключить → включить —"
# ⚠️ reason обязателен: выключение продаж — действие с последствиями,
# и в журнале должно остаться, кто и зачем это сделал.
check "flags: выключить online_booking"     200 POST /admin/flags \
  '{"flag":"online_booking","enabled":false,"reason":"проверка сценария"}'
check "flags: без причины — отказ"          422 POST /admin/flags \
  '{"flag":"online_booking","enabled":false}'
check "flags: включить обратно"             200 POST /admin/flags \
  '{"flag":"online_booking","enabled":true,"reason":"проверка сценария"}'

echo "— заказ целиком: создание → подтверждение → выдача → возврат —"
# ⚠️ Главный сценарий продукта. Одиночные вызовы тут ничего не значат:
# проверяется ЦЕПОЧКА переходов состояния, и каждый следующий шаг
# возможен только если предыдущий действительно случился.
ORD_FROM=$(date -u -d '+3 days' +%Y-%m-%dT10:00:00Z)
ORD_TO=$(date -u -d '+5 days' +%Y-%m-%dT10:00:00Z)
# ⚠️ Вариант выбирается по СВОБОДНОМУ остатку на нужные даты, а не
# первый попавшийся: повторные прогоны разбирают склад, и сценарий
# начинал падать с POOL_EXHAUSTED — то есть на состоянии данных, а не
# на проверяемой логике.
SUP=$(q "SELECT pd.variant_id
         FROM pool_day pd
         JOIN inventory_variant v ON v.id = pd.variant_id AND v.archived_at IS NULL
         JOIN category c ON c.id = v.category_id AND c.code <> 'service'
         WHERE pd.tenant_id='$TID'
           -- ⚠️ И В СЕЗОН: сервер отказывает «шлем в сентябре» кодом
           -- OUT_OF_SEASON, и это правильно — сценарий обязан выбирать
           -- то, что прокат действительно выдаёт на эти даты.
           AND season_month_active(
             EXTRACT(MONTH FROM (now() + interval '3 days'))::int,
             c.season_from_month, c.season_to_month)
           AND pd.day BETWEEN (now() + interval '3 days')::date AND (now() + interval '5 days')::date
         GROUP BY pd.variant_id
         HAVING min(pd.capacity - pd.qty_booked) > 0
         LIMIT 1")
PHONE="+7999$(printf '%07d' $((RANDOM*RANDOM % 10000000)))"

check "заказ: создание" 200 POST /public/orders \
  "{\"tenant\":\"demo\",\"branchId\":\"$BID\",\"from\":\"$ORD_FROM\",\"to\":\"$ORD_TO\",\"lines\":[{\"variantId\":\"$SUP\",\"qty\":1}],\"name\":\"Сценарий Проверка\",\"phone\":\"$PHONE\",\"consentPersonalData\":true,\"consentTerms\":true}"
CODE=$(python3 -c "import json;print(json.load(open('/tmp/sc.json')).get('code',''))" 2>/dev/null)
OID=$(q "SELECT id FROM rental_order WHERE tenant_id='$TID' AND public_code='$CODE'")

if [ -n "$OID" ]; then
  echo "    заказ $CODE"
  # ⚠️ Подтверждение идёт по ТОКЕНУ клиента, а не по id: это разные виды
  # доступа, и путать их нельзя (токен в маршруте персонала означал бы
  # доступ к заказу по знанию ссылки).
  check "заказ: статус awaiting_confirm" 200 GET "/admin/orders/$OID"
  STATUS=$(python3 -c "import json;print(json.load(open('/tmp/sc.json')).get('status',''))" 2>/dev/null)
  [ "$STATUS" = "awaiting_confirm" ] \
    && { printf '  ✓ %-46s %s\n' "заказ: ждёт подтверждения" "$STATUS"; PASS=$((PASS+1)); } \
    || { printf '  ✗ %-46s %s\n' "заказ: ждёт подтверждения" "$STATUS"; FAIL=$((FAIL+1)); }

  # Подтверждаем через БД: токен приходит клиенту письмом, в сценарии его нет.
  q "UPDATE rental_order SET status='confirmed' WHERE id='$OID'" > /dev/null
  # ⚠️ Выдача и возврат идут ПО ПОЗИЦИЯМ, а не по заказу целиком:
  # прокат может выдать часть, а остальное позже. Поэтому в теле —
  # список orderLineId с количеством.
  LINE=$(q "SELECT id FROM order_line WHERE order_id='$OID' LIMIT 1")
  check "выдача" 200 POST /counter/issue \
    "{\"orderId\":\"$OID\",\"lines\":[{\"orderLineId\":\"$LINE\",\"qty\":1}]}"
  check "возврат" 200 POST /counter/return \
    "{\"orderId\":\"$OID\",\"lines\":[{\"orderLineId\":\"$LINE\",\"qty\":1}]}"
  FINAL=$(q "SELECT status FROM rental_order WHERE id='$OID'")
  [ "$FINAL" = "returned" ] \
    && { printf '  ✓ %-46s %s\n' "заказ: цикл замкнулся" "$FINAL"; PASS=$((PASS+1)); } \
    || { printf '  ✗ %-46s ожидали returned, получили %s\n' "заказ: цикл замкнулся" "$FINAL"; FAIL=$((FAIL+1)); }
else
  echo "  ? заказ не создан — цепочка пропущена"
fi

echo "— доступ —"
check "switch: неверный PIN — отказ"        403 POST /staff/switch '{"pin":"0000"}'

echo
echo "итог: $PASS пройдено, $FAIL провалено"
[ "$FAIL" -eq 0 ]
