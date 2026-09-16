#!/usr/bin/env bash
# Сверка ответа нового сервиса с эталоном, снятым со старого стенда.
#
# ⚠️ Главная проверка переезда. Тесты доказывают, что код делает то, что
# задумано; эталон — что он делает то же, что делал раньше. Это разные
# вопросы, и второй важнее: переезд не должен ничего менять.
set -euo pipefail

BASE_DIR="${BASELINE_DIR:-../rental/baseline}"
NEW="${NEW_BASE:-http://localhost:3200}"
OLD="${OLD_BASE:-http://localhost:3100}"

usage() {
  cat <<'USAGE'
compare.sh <команда> [аргументы]

  all                     сверить все снятые эталоны
  one <файл> <путь+query> сверить один
  capture <файл> <путь+query>
                          снять эталон со СТАРОГО стенда (до переезда!)

Примеры:
  compare.sh all
  compare.sh one public_catalog_tenant_demo '/api/v1/public/catalog?tenant=demo'
  compare.sh capture public_quote '/api/v1/public/catalog?tenant=demo'
USAGE
}

norm() { python3 -m json.tool --sort-keys "$1"; }

alive() {
  curl -sf -o /dev/null "$1/health" 2>/dev/null && return 0
  curl -sf -o /dev/null "$1/" 2>/dev/null && return 0
  return 1
}

cmd_one() {
  local name="$1" path="$2" base="$BASE_DIR/$1.json" tmp
  tmp="$(mktemp)"
  if [ ! -f "$base" ]; then
    echo "  ✗ $name — эталона нет: $base" >&2
    echo "    снять: compare.sh capture $name '<путь>'" >&2
    return 1
  fi
  curl -s "$NEW$path" > "$tmp"
  if diff <(norm "$base") <(norm "$tmp") > /dev/null 2>&1; then
    echo "  ✓ $name"
    rm -f "$tmp"; return 0
  fi
  echo "  ✗ $name"
  diff <(norm "$base") <(norm "$tmp") | head -25
  echo "    полностью: diff <(python3 -m json.tool --sort-keys $base) <(python3 -m json.tool --sort-keys $tmp)"
  return 1
}

cmd_capture() {
  local name="$1" path="$2"
  alive "$OLD" || { echo "⚠️ Старый стенд $OLD не отвечает. Поднять: cd ../rental && docker compose up -d" >&2; exit 1; }
  mkdir -p "$BASE_DIR"
  curl -s "$OLD$path" > "$BASE_DIR/$name.json"
  echo "снято: $BASE_DIR/$name.json ($(wc -c < "$BASE_DIR/$name.json") байт)"
  echo "⚠️ Эталон снимается ДО переезда эндпоинта. После — он уже не эталон."
}

cmd_all() {
  alive "$NEW" || { echo "⚠️ Сервис $NEW не отвечает. Поднять: make dev" >&2; exit 1; }
  [ -d "$BASE_DIR" ] || { echo "⚠️ Каталога эталонов нет: $BASE_DIR" >&2; exit 1; }

  local pass=0 fail=0
  shopt -s nullglob
  for f in "$BASE_DIR"/*.json; do
    local name path
    name="$(basename "$f" .json)"
    # Имя файла кодирует запрос: public_catalog_tenant_demo → /api/v1/public/catalog?tenant=demo
    path="$(python3 - "$name" <<'PY'
import sys, re
n = sys.argv[1]
# первые сегменты до первого параметра — путь, остальное — query
m = re.match(r'^(public|admin|counter|staff|platform)_([a-z-]+)(?:_(.*))?$', n)
if not m:
    print(''); raise SystemExit
contour, res, rest = m.group(1), m.group(2), m.group(3) or ''
q = ''
if rest:
    parts = rest.split('_')
    pairs = [f"{parts[i]}={parts[i+1]}" for i in range(0, len(parts) - 1, 2)]
    q = '?' + '&'.join(pairs)
print(f"/api/v1/{contour}/{res}{q}")
PY
)"
    if [ -z "$path" ]; then
      echo "  ? $name — имя не разбирается в запрос, сверить вручную"
      continue
    fi
    if cmd_one "$name" "$path"; then pass=$((pass+1)); else fail=$((fail+1)); fi
  done
  echo
  echo "итог: $pass совпало, $fail разошлось"
  # ⚠️ Явный ненулевой код: без него расхождение видно глазом, но CI
  # считает шаг успешным — то есть сверка перестаёт быть проверкой.
  if [ "$fail" -ne 0 ]; then return 1; fi
  return 0
}

# ⚠️ Код возврата пробрасывается наружу: сверка нужна и в CI, где
# читают именно его, а не текст.
case "${1:-}" in
  all)     shift; cmd_all; exit $? ;;
  one)     shift; [ $# -eq 2 ] || { usage; exit 2; }; cmd_one "$1" "$2"; exit $? ;;
  capture) shift; [ $# -eq 2 ] || { usage; exit 2; }; cmd_capture "$1" "$2" ;;
  *)       usage; exit 2 ;;
esac
