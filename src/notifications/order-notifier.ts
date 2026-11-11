import type { PrismaClient } from '../generated/prisma/client.js';
import { escapeHtml } from '../journey/site-renderer.js';
import { tenge } from '../journey/products.js';
import { contentLocale, runWithLocale, tr } from '../i18n/i18n.js';
import { emailConfig, sendEmail } from './email.js';
import { sendTelegramMessage, telegramConfig } from './telegram.js';
import type { ChannelStatus } from './lead-notifier.js';

export interface OrderForMessage {
  kind: 'created' | 'cancelled_by_client'; siteName: string; projectId: string; number: number;
  items: Array<{ name: string; price: number; quantity: number }>; totalTiyn: number; deliveryTitle: string; paymentMethod: string;
  clientName: string; clientPhone: string; address: string | null; comment: string | null;
}

/** The owner's message in the current language: what was ordered, total, how to deliver and whom to call. */
export function orderText(order: OrderForMessage, appUrl: string | undefined): string {
  return [
    order.kind === 'created' ? tr('Новый заказ №{0} с сайта «{1}»', [order.number, order.siteName]) : tr('Клиент отменил заказ №{0} на сайте «{1}»', [order.number, order.siteName]),
    ...order.items.map((item) => `${item.name} × ${item.quantity} — ${tenge(item.price * item.quantity)}`),
    tr('Итого: {0}', [tenge(Math.round(order.totalTiyn / 100))]),
    `${order.deliveryTitle} · ${order.paymentMethod === 'transfer' ? tr('оплата переводом') : tr('оплата при получении')}`,
    tr('Клиент: {0}', [`${order.clientName}, ${order.clientPhone}`]),
    order.address ? tr('Адрес: {0}', [order.address]) : null,
    order.comment ? tr('Комментарий: {0}', [order.comment]) : null,
    appUrl ? tr('Все заказы: {0}', [new URL(`/projects/${order.projectId}/orders`, appUrl).toString()]) : null,
  ].filter(Boolean).join('\n');
}

/** Tells the owner about a new or cancelled order using the site's notification settings, in the owner's language. Never throws. */
export async function notifyOrder(prisma: PrismaClient, orderId: string, kind: OrderForMessage['kind']): Promise<ChannelStatus> {
  try {
    const order = await prisma.storeOrder.findUnique({
      where: { id: orderId },
      select: {
        id: true, projectId: true, number: true, items: true, totalTiyn: true, deliveryTitle: true, paymentMethod: true, clientName: true, clientPhone: true, address: true, comment: true,
        publication: { select: { notifyTelegram: true, notifyEmail: true } },
        project: { select: { name: true, owner: { select: { email: true, locale: true, externalIdentities: { where: { provider: 'telegram' }, select: { chatId: true } } } } } },
      },
    });
    if (!order) return 'failed';
    return await runWithLocale(contentLocale(order.project.owner.locale), async () => {
      const text = orderText({ ...order, kind, siteName: order.project.name, items: order.items as OrderForMessage['items'] }, process.env.PUBLIC_APP_URL);
      let telegram: ChannelStatus = 'off';
      if (order.publication.notifyTelegram) {
        const config = telegramConfig();
        const chatId = order.project.owner.externalIdentities[0]?.chatId;
        telegram = !config ? 'not_configured' : !chatId ? 'not_linked' : (await sendTelegramMessage(config, chatId, text)) ? 'sent' : 'failed';
      }
      if (order.publication.notifyEmail) {
        const config = emailConfig();
        if (config) await sendEmail(config, order.project.owner.email, tr(kind === 'created' ? 'Новый заказ №{0}: {1}' : 'Отмена заказа №{0}: {1}', [order.number, order.project.name]), `<pre style="font:15px/1.5 system-ui,sans-serif;white-space:pre-wrap">${escapeHtml(text)}</pre>`);
      }
      if (kind === 'created') await prisma.storeOrder.update({ where: { id: order.id }, data: { telegramStatus: telegram } });
      return telegram;
    });
  } catch {
    return 'failed';
  }
}
