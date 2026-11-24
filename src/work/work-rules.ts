// «Моя работа»: how a specialist's money and time are summed. Pure, tested without a database.
import { minutesOf } from '../journey/worktime.js';

/**
 * A stage payment goes: due → checkout (owner is paying) → held (the platform holds it until payout) → paid_out;
 * or paid_direct when the owner paid outside BuildPath; refunded when it went back to the owner.
 * For the specialist: «ждёт оплаты владельцем», «у BuildPath, будет выплачено», «выплачено».
 * Held and paid-out amounts are what reaches the specialist after the platform fee (payoutTiyn) when it is known.
 */
export function moneyByStatus(payments: Array<{ amountTiyn: number; payoutTiyn: number | null; status: string }>) {
  let awaitingOwner = 0, held = 0, paidOut = 0;
  for (const payment of payments) {
    const toSpecialist = payment.payoutTiyn ?? payment.amountTiyn;
    if (payment.status === 'due' || payment.status === 'checkout') awaitingOwner += payment.amountTiyn;
    else if (payment.status === 'held' || payment.status === 'paid') held += toSpecialist;
    else if (payment.status === 'paid_out') paidOut += toSpecialist;
    else if (payment.status === 'paid_direct') paidOut += payment.amountTiyn;
  }
  return { awaitingOwner, held, paidOut };
}

/** Minutes worked in the last 7 × 24 hours, whatever their approval status. */
export function weekMinutes(entries: Array<{ startedAt: Date; endedAt: Date }>, now: Date): number {
  const from = now.getTime() - 7 * 86_400_000;
  return entries.filter((entry) => entry.startedAt.getTime() >= from).reduce((sum, entry) => sum + minutesOf(entry), 0);
}
