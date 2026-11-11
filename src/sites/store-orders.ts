// Order writes for published stores. Prices are taken from the accepted catalogue, never from the form.
// Order numbers are sequential per project; a transaction-scoped advisory lock per project keeps them unique.
import { randomBytes } from 'node:crypto';
import type { PrismaClient } from '../generated/prisma/client.js';
import { priceCart, type Catalog } from '../journey/products.js';
import type { OrderForm } from './store-pages.js';
import { tokenHash } from './booking-store.js';

export type OrderResult = { ok: true; id: string; token: string; number: number } | { ok: false; reason: 'empty' };

export async function createOrder(prisma: PrismaClient, site: { publicationId: string; projectId: string }, catalog: Catalog, form: OrderForm, ipHash: string): Promise<OrderResult> {
  const priced = priceCart(catalog, form.lines);
  const delivery = catalog.delivery.find((option) => option.key === form.delivery);
  if (!priced.lines.length || !delivery) return { ok: false, reason: 'empty' };
  const items = priced.lines.map((line) => ({ key: line.key, name: line.name, price: line.price, quantity: line.quantity }));
  const itemsTiyn = priced.itemsTotal * 100;
  const deliveryTiyn = delivery.price * 100;
  const token = randomBytes(24).toString('base64url');
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`order:${site.projectId}`}))`;
    const last = await tx.storeOrder.findFirst({ where: { projectId: site.projectId }, orderBy: { number: 'desc' }, select: { number: true } });
    const number = (last?.number ?? 0) + 1;
    const created = await tx.storeOrder.create({
      data: {
        projectId: site.projectId, publicationId: site.publicationId, number, items, itemsTiyn, deliveryKey: delivery.key, deliveryTitle: delivery.title, deliveryTiyn,
        totalTiyn: itemsTiyn + deliveryTiyn, paymentMethod: form.payment, clientName: form.name, clientPhone: form.phone, address: form.address, comment: form.comment,
        tokenHash: tokenHash(token), consentAt: new Date(), ipHash,
      },
      select: { id: true },
    });
    return { ok: true as const, id: created.id, token, number };
  });
}

/** A client may cancel only an order the store has not confirmed yet. */
export const canClientCancelOrder = (status: string) => status === 'new';
