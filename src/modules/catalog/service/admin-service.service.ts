/**
 * Список работ техника: что сейчас в обслуживании.
 *
 * ⚠️ Право `service.record`, а не `inventory.manage`: у техника
 * инвентарём управлять нельзя (заводить позиции, списывать), но
 * обслуживание — ровно его работа. До этого эндпоинта право было
 * выдано роли и не проверялось НИ ОДНИМ обработчиком — то есть
 * существовало только на бумаге.
 */
import type { Deps } from '~/kernel/deps'
import type { Session } from '~/kernel/session'
import QRCode from 'qrcode'
import { itemHistory, serviceTasks } from '~/domain/service/service'
import { findByCode } from '~/domain/inventory/items'

export async function getService(
  session: Session,
  input: Record<string, unknown>,
  deps: Deps,
) {

  // ⚠️ Техник и стойка видят ТОЛЬКО свои филиалы: внутри тенанта нужна
  // вторая граница поверх RLS, иначе сотрудник одной точки видит склад
  // всей сети. Владелец и администратор — все филиалы.
  const all = session.activeRole === 'owner' || session.activeRole === 'admin'

  /**
   * ⚠️ QR рисует сервер, как и для инвентаря: одна реализация на
   * экран, на печать и на список техника — иначе миниатюра и наклейка
   * однажды разойдутся. Содержит только номер, никогда не команду.
   */
  const qrFor = (code: string) =>
    QRCode.toString(code, { type: 'svg', margin: 0, errorCorrectionLevel: 'M' })

  const q = input
  const code = typeof q.code === 'string' ? q.code.trim() : ''
  const historyFor = typeof q.itemId === 'string' ? q.itemId : ''

  return deps.db.tx(session.tenantId, async (c) => {
    // ⚠️ История — отдельный запрос, а не поле каждой строки списка:
    // движений у вещи за сезон десятки, и тянуть их для всего списка
    // значит платить за то, что откроют у одной.
    if (historyFor) {
      return { history: await itemHistory(c, { tenantId: session.tenantId, itemId: historyFor }) }
    }

    // Скан: номер вещи → сама вещь. «Не нашли» это нормальный ответ
    // на чужую или стёртую метку, а не ошибка.
    if (code) {
      const item = await findByCode(c, { tenantId: session.tenantId, code })
      const visible = item && (all || session.branchIds.includes(item.branchId)) ? item : null
      return { item: visible }
    }

    const tasks = await serviceTasks(c, {
      tenantId: session.tenantId,
      branchIds: all ? [] : session.branchIds,
    })

    return {
      tasks: await Promise.all(tasks.map(async (t) => ({
        ...t,
        // Позиции по количеству вещь не различают — QR им не нужен.
        qr: t.labelCode ? await qrFor(t.labelCode) : null,
      }))),
    }
  })
}
