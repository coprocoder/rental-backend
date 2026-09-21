/**
 * Расчёт рекомендованного DIN по параметрам, названным на стойке.
 *
 * ⚠️ Нужен отдельно от /counter/history, и это не дубль. History отдаёт
 * рекомендацию по СОХРАНЁННЫМ параметрам — а они есть только при
 * действующем согласии «запомнить мои параметры». Без согласия
 * параметров нет и быть не должно (152-ФЗ), но техник всё равно стоит
 * перед клиентом, у которого можно спросить вес и рост вслух.
 * Отказать ему в расчёте из-за отсутствия согласия значило бы наказать
 * за соблюдение закона.
 *
 * ⚠️ Параметры НЕ СОХРАНЯЮТСЯ этим запросом. Они приходят, считаются и
 * забываются: сохранение — отдельное решение клиента, выраженное
 * согласием, а не побочный эффект того, что техник ввёл цифры в форму.
 *
 * ⚠️ Ответ — КОД и ДИАПАЗОН, а не число (железное правило №7). Точное
 * значение техник берёт из таблицы своего крепления и подписывает.
 */
import type { Deps } from '~/kernel/deps'
import type { Session } from '~/kernel/session'
import * as v from 'valibot'
import { apiError } from '~/kernel/errors'
import { recommendDin } from '~/domain/fitting/din'

export const DinBody = v.object({
  // Границы широкие намеренно: ребёнок 15 кг и крупный взрослый 150 —
  // оба реальны, а сузить их значит отказать настоящему клиенту.
  weight: v.pipe(v.number(), v.minValue(10), v.maxValue(200)),
  height: v.optional(v.pipe(v.number(), v.minValue(80), v.maxValue(230))),
  age: v.optional(v.pipe(v.number(), v.integer(), v.minValue(2), v.maxValue(110))),
  bslMm: v.optional(v.pipe(v.number(), v.minValue(200), v.maxValue(400))),
})

export interface PostDinRequest {
  body: unknown
}

export async function postDin(
  session: Session,
  req: PostDinRequest,
  deps: Deps,
) {

  const parsed = v.safeParse(DinBody, req.body)
  if (!parsed.success) {
    throw apiError('VALIDATION_FAILED', 'Нужен хотя бы вес — он ведущий параметр')
  }

  return recommendDin(parsed.output)
}
