// Stable error codes from SQL/Edge Functions -> short Russian messages.
const MESSAGES: Record<string, string> = {
  slot_taken: 'Это время только что заняли. Выберите другое.',
  slot_unavailable: 'Это время недоступно. Выберите другое.',
  product_unavailable: 'Один из товаров сейчас недоступен. Обновите корзину.',
  invalid_quantity: 'Проверьте количество товара.',
  duplicate_product: 'Товар добавлен дважды.',
  empty_order: 'Корзина пуста.',
  too_many_lines: 'Слишком много позиций в одном заказе.',
  invalid_name: 'Укажите имя (от 2 символов).',
  invalid_phone: 'Проверьте номер телефона.',
  invalid_email: 'Проверьте e-mail.',
  note_too_long: 'Комментарий слишком длинный.',
  too_late_to_change: 'Изменить заказ уже нельзя — позвоните в магазин.',
  not_reschedulable: 'Этот заказ нельзя перенести.',
  not_cancellable: 'Этот заказ нельзя отменить.',
  order_not_found: 'Заказ не найден или ссылка устарела.',
  tenant_not_found: 'Магазин не найден.',
  rate_limited: 'Слишком много запросов. Подождите минуту.',
  idempotency_conflict: 'Запрос уже отправлен с другими данными. Обновите страницу.',
  no_resource_for_product: 'Сейчас этот товар не готовят. Попробуйте позже.',
  forbidden: 'Нет доступа к этому магазину.',
  resource_busy: 'Ресурс занят в это время.',
  refund_exceeds_paid: 'Возврат больше полученной оплаты.',
  invalid_transition: 'Это действие сейчас недоступно.',
  invalid_amount: 'Проверьте сумму.',
  network: 'Нет соединения. Проверьте интернет и повторите.',
  invalid_credentials: 'Неверный e-mail или пароль.',
}

export class ApiError extends Error {
  code: string
  status: number
  detail?: string | null
  constructor(code: string, status = 0, detail?: string | null) {
    super(code)
    this.code = code
    this.status = status
    this.detail = detail
  }
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return MESSAGES[e.code] ?? 'Что-то пошло не так. Повторите попытку.'
  if (e instanceof TypeError) return MESSAGES.network!
  return 'Что-то пошло не так. Повторите попытку.'
}

export function errorCode(e: unknown): string | null {
  return e instanceof ApiError ? e.code : null
}
