/**
 * Публичный контракт модуля брони: заказ, подтверждение, документы.
 *
 * Владение записью: `rental_order`, `order_line`, `order_token`,
 * `waitlist`, `customer`, `consent`, `agreement`.
 */
export { registerBookingRoutes } from './http/booking.controller'
export { getDocument, DOCUMENT_KINDS, type DocumentKind } from './service/agreement.service'
export { registerBookingAdminRoutes } from './http/admin.controller'
export { registerBookingMutations } from './http/mutations.controller'
export { registerBookingPublic } from './http/public.controller'
