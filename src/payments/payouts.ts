// Rules for paying specialists through BuildPath: fee split and payout account checks.

/** Platform fee in basis points (100 = 1%), rounded to whole tiyn in the specialist's favour. */
export function splitFee(amountTiyn: number, feeBp: number): { feeTiyn: number; payoutTiyn: number } {
  const feeTiyn = Math.floor((amountTiyn * feeBp) / 10_000);
  return { feeTiyn, payoutTiyn: amountTiyn - feeTiyn };
}

/** Kazakhstan IBAN: KZ, 2 check digits, 3-digit bank code, 13 account characters; ISO 13616 mod-97 check. */
export function normalizeIban(raw: string): string | null {
  const iban = raw.replace(/[\s-]/g, '').toUpperCase();
  if (!/^KZ\d{2}\d{3}[0-9A-Z]{13}$/.test(iban)) return null;
  const rearranged = `${iban.slice(4)}${iban.slice(0, 4)}`.replace(/[A-Z]/g, (letter) => String(letter.charCodeAt(0) - 55));
  let remainder = 0;
  for (const digit of rearranged) remainder = (remainder * 10 + Number(digit)) % 97;
  return remainder === 1 ? iban : null;
}

export const STAGE_ORDER_PREFIX = 'sp-';
