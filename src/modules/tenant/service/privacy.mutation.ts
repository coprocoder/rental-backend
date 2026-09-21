/**
 * Запросы субъекта персональных данных: экспорт и удаление.
 *
 * ⚠️ Приходят через ТЕНАНТА, а не напрямую к платформе: оператор
 * персональных данных — прокат, платформа лишь обработчик
 * (../rental-docs/docs/04-тз/00-общее/07-роль-и-риски.md). Поэтому эндпоинт под сессией
 * сотрудника, а не публичный.
 *
 * ⚠️ Удаление — это обезличивание: строку заказа удалить нельзя, на
 * неё ссылаются движения склада и запись «кто выставил DIN».
 * Требование исполняется в части ПД, хозяйственные записи остаются.
 */
import type { Deps } from '~/kernel/deps'
import type { Session } from '~/kernel/session'
import * as v from 'valibot'
import { canonicalPhone } from '~/common/utils/phone'
import { apiError, mapDbError } from '~/kernel/errors'
import {
  deleteSubjectData,
  exportSubjectData,
  exportTenantData,
} from '~/domain/admin/privacy'

const Body = v.variant('action', [
  v.object({
    action: v.literal('export_subject'),
    // ⚠️ Та же нормализация, что при записи: иначе поиск субъекта
    // по «8999…» не найдёт запись, сохранённую как «+7999…»,
    // и выгрузка или удаление по 152-ФЗ вернут не все его данные.
    phone: v.pipe(
      v.string(),
      v.transform(canonicalPhone),
      v.check((x) => x.length === 12, 'Телефон в формате +7XXXXXXXXXX'),
    ),
  }),
  v.object({
    action: v.literal('delete_subject'),
    // ⚠️ Та же нормализация, что при записи: иначе поиск субъекта
    // по «8999…» не найдёт запись, сохранённую как «+7999…»,
    // и выгрузка или удаление по 152-ФЗ вернут не все его данные.
    phone: v.pipe(
      v.string(),
      v.transform(canonicalPhone),
      v.check((x) => x.length === 12, 'Телефон в формате +7XXXXXXXXXX'),
    ),
    reason: v.optional(v.pipe(v.string(), v.maxLength(500))),
  }),
  v.object({ action: v.literal('export_tenant') }),
])

export interface PostPrivacyRequest {
  body: unknown
}

export async function postPrivacy(
  session: Session,
  req: PostPrivacyRequest,
  deps: Deps,
) {
  // Работа с ПД — уровень владельца: это юридическая ответственность
  // проката, а не рутина стойки.

  const parsed = v.safeParse(Body, req.body)
  if (!parsed.success) throw apiError('VALIDATION_FAILED', 'Проверьте запрос')
  const input = parsed.output

  try {
    return await deps.db.tx(session.tenantId, async (c) => {
      if (input.action === 'export_subject') {
        return exportSubjectData(c, { tenantId: session.tenantId, phone: input.phone })
      }
      if (input.action === 'delete_subject') {
        return deleteSubjectData(c, {
          tenantId: session.tenantId,
          phone: input.phone,
          staffId: session.activeStaffId,
          reason: input.reason,
        })
      }
      // Полная выгрузка тенанта: аргумент при продаже не меньше, чем
      // требование закона — «не сможете уйти» отпугивает покупателя.
      return exportTenantData(c, session.tenantId)
    })
  } catch (err) {
    throw mapDbError(err)
  }
}
