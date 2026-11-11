// Script-free pages of a published store: cart (kept in the address) → order form → «Ваш заказ».
import type { SiteMeta } from '../journey/artifacts.js';
import { escapeHtml } from '../journey/site-renderer.js';
import { CATALOG_LIMITS, cartParam, parseCart, priceCart, tenge, withLine, type Catalog, type CartLine } from '../journey/products.js';
import { tr } from '../i18n/i18n.js';
import { page } from './site-pages.js';

export const ORDER_FORM_PATH = '/__forms/order';
export const ORDER_CANCEL_PATH = '/__forms/order-cancel';

const style = `<style>.lines{list-style:none;padding:0;margin:16px 0;display:grid;gap:10px}.lines li{border:1px solid rgba(0,0,0,.12);border-radius:12px;padding:12px 14px}.lines .row{display:flex;justify-content:space-between;gap:10px;align-items:center}
.qty{display:flex;gap:6px;align-items:center;margin-top:8px}.qty a{display:inline-flex;align-items:center;justify-content:center;min-width:44px;min-height:44px;border:1px solid rgba(0,0,0,.2);border-radius:10px;text-decoration:none;font-weight:800;font-size:20px}.qty span{min-width:28px;text-align:center;font-weight:700}
.total{font-size:20px;font-weight:800}.summary{border:1px solid rgba(0,0,0,.12);border-radius:12px;padding:14px 16px;margin:12px 0}.summary p{margin:4px 0}
form{display:grid;gap:14px;margin:18px 0}fieldset{border:1px solid rgba(0,0,0,.15);border-radius:12px;padding:10px 14px;display:grid;gap:8px}legend{font-weight:700;font-size:15px;padding:0 4px}
label{display:grid;gap:6px;font-weight:700;font-size:15px}.choice{display:flex;gap:10px;align-items:flex-start;font-weight:400}.choice input{width:22px;height:22px;flex:none;margin-top:2px}.choice small{display:block;opacity:.8}
input,textarea{font:inherit;font-size:16px;padding:12px;border:1px solid rgba(0,0,0,.25);border-radius:10px;background:#fff;color:#111}.consent{display:flex;gap:10px;align-items:flex-start;font-weight:400;font-size:14px}.consent input{width:22px;height:22px;flex:none;margin-top:2px}
.hp{position:absolute;left:-10000px;width:1px;height:1px;overflow:hidden}button{border:0;cursor:pointer;font:inherit;font-weight:700;padding:15px 22px;border-radius:12px;min-height:48px}.back{display:inline-block;margin-top:8px}</style>`;

function shell(meta: SiteMeta, title: string, body: string): string {
  return page(meta, title, `${style}<style>button{background:${meta.theme.accent};color:${meta.theme.accentText}}</style>${body}`);
}

const cartLink = (lines: CartLine[]) => `/cart${lines.length ? `?i=${cartParam(lines)}` : ''}`;
const deliveryOf = (catalog: Catalog, key: string | null) => catalog.delivery.find((option) => option.key === key) ?? null;

export interface OrderValues { name?: string; phone?: string; address?: string; comment?: string; delivery?: string; payment?: string }

/** Cart with − / + links, then the order form. Prices are recomputed from the accepted catalogue on every view. */
export function cartPage(meta: SiteMeta, catalog: Catalog, raw: string | null, error: string | null = null, values: OrderValues = {}): string {
  const lines = parseCart(raw);
  const priced = priceCart(catalog, lines);
  const kept = lines.filter((line) => priced.lines.some((item) => item.key === line.key));
  const missing = priced.unavailable.length ? `<p role="status">${tr('Больше нет в наличии: {0}. Мы убрали это из корзины.', [escapeHtml(priced.unavailable.join(', '))])}</p>` : '';
  if (!priced.lines.length) {
    return shell(meta, tr('Корзина'), `<h1>${tr('Корзина пуста')}</h1>${missing}<p>${tr('Выберите товары в каталоге.')}</p><a class="back" href="/#catalog">← ${tr('В каталог')}</a>`);
  }
  const rows = priced.lines.map((line) => `<li><div class="row"><strong>${escapeHtml(line.name)}</strong><span>${escapeHtml(tenge(line.sum))}</span></div>
<small>${escapeHtml(tenge(line.price))}${line.unit ? ` / ${escapeHtml(line.unit)}` : ''}</small>
<div class="qty"><a href="${cartLink(withLine(kept, line.key, line.quantity - 1))}" aria-label="${escapeHtml(tr('Меньше: {0}', [line.name]))}">−</a><span>${line.quantity}</span>${line.quantity < CATALOG_LIMITS.quantity ? `<a href="${cartLink(withLine(kept, line.key, line.quantity + 1))}" aria-label="${escapeHtml(tr('Больше: {0}', [line.name]))}">+</a>` : ''}</div></li>`).join('');
  const short = catalog.minOrder && priced.itemsTotal < catalog.minOrder
    ? `<p role="alert"><strong>${tr('Минимальный заказ — {0}. Добавьте товаров ещё на {1}.', [tenge(catalog.minOrder), tenge(catalog.minOrder - priced.itemsTotal)])}</strong></p>` : '';
  const chosenDelivery = values.delivery ?? catalog.delivery[0]?.key ?? '';
  const delivery = catalog.delivery.map((option) => `<label class="choice"><input type="radio" name="delivery" value="${escapeHtml(option.key)}" required${option.key === chosenDelivery ? ' checked' : ''}><span>${escapeHtml(option.title)} — ${option.price ? escapeHtml(tenge(option.price)) : tr('бесплатно')}${option.note ? `<small>${escapeHtml(option.note)}</small>` : ''}</span></label>`).join('');
  const methods = [
    ...(catalog.payment.onDelivery ? [{ key: 'on_delivery', title: tr('При получении'), note: tr('Наличными или картой, когда заберёте заказ.') }] : []),
    ...(catalog.payment.transfer ? [{ key: 'transfer', title: tr('Переводом'), note: catalog.payment.transferNote || tr('Реквизиты пришлём после подтверждения заказа.') }] : []),
  ];
  const chosenPayment = values.payment ?? methods[0]?.key ?? '';
  const payment = methods.map((method) => `<label class="choice"><input type="radio" name="payment" value="${method.key}" required${method.key === chosenPayment ? ' checked' : ''}><span>${escapeHtml(method.title)}<small>${escapeHtml(method.note)}</small></span></label>`).join('');
  const needsAddress = catalog.delivery.some((option) => option.needsAddress);
  return shell(meta, tr('Корзина'), `<h1>${tr('Корзина')}</h1>${missing}<ul class="lines">${rows}</ul><p class="total">${tr('Товары: {0}', [tenge(priced.itemsTotal)])}</p>${short}
${error ? `<p role="alert"><strong>${escapeHtml(error)}</strong></p>` : ''}
${short ? '' : `<form method="post" action="${ORDER_FORM_PATH}"><input type="hidden" name="i" value="${escapeHtml(cartParam(kept))}">
<fieldset><legend>${tr('Как получить')}</legend>${delivery}</fieldset>
<fieldset><legend>${tr('Как оплатить')}</legend>${payment}</fieldset>
<label>${tr('Ваше имя')}<input name="name" required maxlength="80" autocomplete="name" value="${escapeHtml(values.name ?? '')}"></label>
<label>${tr('Телефон')}<input name="phone" required maxlength="30" inputmode="tel" autocomplete="tel" placeholder="+7 700 000 00 00" value="${escapeHtml(values.phone ?? '')}"></label>
${needsAddress ? `<label>${tr('Адрес доставки')}<small>${tr('Нужен, если выбрали доставку.')}</small><textarea name="address" maxlength="300" autocomplete="street-address">${escapeHtml(values.address ?? '')}</textarea></label>` : ''}
<label>${tr('Комментарий (необязательно)')}<textarea name="comment" maxlength="300">${escapeHtml(values.comment ?? '')}</textarea></label>
<div class="hp" aria-hidden="true"><label>${tr('Сайт')}<input name="website" tabindex="-1" autocomplete="off"></label></div>
<label class="consent"><input type="checkbox" name="consent" value="yes" required><span>${tr('Согласен(на) на обработку моих данных для заказа.')} <a href="/privacy">${tr('Как используются данные')}</a></span></label>
<button type="submit">${tr('Оформить заказ')}</button></form>`}<a class="back" href="/#catalog">← ${tr('Продолжить покупки')}</a>`);
}

export interface OrderForm { lines: CartLine[]; delivery: string; payment: 'on_delivery' | 'transfer'; name: string; phone: string; address: string | null; comment: string | null }

/** Validates the urlencoded order form against the accepted catalogue; spam (honeypot) is reported separately. */
export function parseOrderForm(raw: string, catalog: Catalog): { ok: true; form: OrderForm } | { ok: false; spam: boolean; error: string; values: OrderValues; cart: string } {
  const form = new URLSearchParams(raw);
  const clean = (value: string | null) => (value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim();
  const values: OrderValues = { name: clean(form.get('name')), phone: clean(form.get('phone')), address: clean(form.get('address')), comment: clean(form.get('comment')), delivery: clean(form.get('delivery')), payment: clean(form.get('payment')) };
  const lines = parseCart(form.get('i'));
  const cart = cartParam(lines);
  const fail = (error: string) => ({ ok: false as const, spam: false, error, values, cart });
  if (clean(form.get('website'))) return { ok: false, spam: true, error: '', values, cart };
  const priced = priceCart(catalog, lines);
  if (!priced.lines.length) return fail(tr('Корзина пуста — выберите товары заново.'));
  if (priced.unavailable.length) return fail(tr('Больше нет в наличии: {0}. Проверьте корзину.', [priced.unavailable.join(', ')]));
  if (catalog.minOrder && priced.itemsTotal < catalog.minOrder) return fail(tr('Минимальный заказ — {0}.', [tenge(catalog.minOrder)]));
  const delivery = deliveryOf(catalog, values.delivery ?? null);
  if (!delivery) return fail(tr('Выберите, как получить заказ.'));
  const payment = values.payment === 'transfer' && catalog.payment.transfer ? 'transfer' : values.payment === 'on_delivery' && catalog.payment.onDelivery ? 'on_delivery' : null;
  if (!payment) return fail(tr('Выберите, как оплатить.'));
  if (form.get('consent') !== 'yes') return fail(tr('Чтобы оформить заказ, отметьте согласие на обработку данных.'));
  if (!values.name || values.name.length > 80) return fail(tr('Укажите имя (до 80 символов).'));
  if (!/^\+?\d{10,15}$/.test(values.phone!.replace(/[\s()-]/g, ''))) return fail(tr('Укажите телефон полностью, например +7 700 000 00 00.'));
  if (delivery.needsAddress && (values.address ?? '').length < 5) return fail(tr('Укажите адрес доставки.'));
  if ((values.address ?? '').length > 300 || (values.comment ?? '').length > 300) return fail(tr('Адрес и комментарий — до 300 символов.'));
  return { ok: true, form: { lines: priced.lines.map((line) => ({ key: line.key, quantity: line.quantity })), delivery: delivery.key, payment, name: values.name, phone: values.phone!, address: delivery.needsAddress ? values.address! : null, comment: values.comment || null } };
}

export interface OrderView {
  number: number; items: Array<{ name: string; price: number; quantity: number }>; itemsTiyn: number; deliveryTitle: string; deliveryTiyn: number; totalTiyn: number;
  paymentMethod: string; status: string; address: string | null; createdAt: Date;
}

const statusText = (status: string): string => ({
  new: () => tr('Заказ получен — магазин скоро подтвердит его.'),
  confirmed: () => tr('Заказ подтверждён.'),
  done: () => tr('Заказ выполнен.'),
  cancelled_by_owner: () => tr('Магазин отменил заказ.'),
  cancelled_by_client: () => tr('Вы отменили заказ.'),
} as Record<string, () => string>)[status]?.() ?? '';

export function orderPage(meta: SiteMeta, order: OrderView, token: string, justCreated: boolean, transferNote: string): string {
  const money = (tiyn: number) => tenge(Math.round(tiyn / 100));
  const items = order.items.map((item) => `<p>${escapeHtml(item.name)} × ${item.quantity} — ${escapeHtml(tenge(item.price * item.quantity))}</p>`).join('');
  const contacts = meta.ownerContacts.map((contact) => `<p>${escapeHtml(tr(contact.label))}: ${escapeHtml(contact.value)}</p>`).join('');
  const pay = order.paymentMethod === 'transfer' ? tr('Оплата переводом. {0}', [transferNote || tr('Реквизиты пришлём после подтверждения заказа.')]) : tr('Оплата при получении.');
  const cancel = order.status === 'new'
    ? `<form method="post" action="${ORDER_CANCEL_PATH}"><input type="hidden" name="token" value="${escapeHtml(token)}"><button type="submit">${tr('Отменить заказ')}</button></form><p>${tr('Отменить можно, пока магазин не подтвердил заказ. Потом — по контактам ниже.')}</p>` : '';
  return shell(meta, tr('Заказ №{0}', [order.number]), `<h1>${justCreated ? tr('Заказ №{0} оформлен!', [order.number]) : tr('Заказ №{0}', [order.number])}</h1><p role="status"><strong>${escapeHtml(statusText(order.status))}</strong></p>
<div class="summary">${items}<p>${escapeHtml(order.deliveryTitle)} — ${order.deliveryTiyn ? escapeHtml(money(order.deliveryTiyn)) : tr('бесплатно')}</p>${order.address ? `<p>${tr('Адрес: {0}', [escapeHtml(order.address)])}</p>` : ''}<p class="total">${tr('Итого: {0}', [escapeHtml(money(order.totalTiyn))])}</p><p>${escapeHtml(pay)}</p></div>
${justCreated ? `<p><strong>${tr('Сохраните эту страницу в закладки')}</strong> — ${tr('по ней видно, что с заказом.')}</p>` : ''}${cancel}${contacts ? `<p>${tr('Контакты магазина:')}</p>${contacts}` : ''}<a class="back" href="/">← ${tr('На сайт')}</a>`);
}
