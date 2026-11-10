import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { PaymentProviderError, freedomCallback, freedomCheckout, freedomReply, freedomSignature } from './providers.js';
import { activeProvider } from './payments.service.js';

const config = { merchantId: '545', secret: 'secret-key', apiUrl: 'https://api.freedompay.kz', testing: true };
const resultUrl = 'https://api.buildpath.kz/api/v1/payments/freedompay/result';

describe('Freedom Pay adapter', () => {
  it('signs «script;values sorted by key;secret» with MD5', () => {
    // The documented example: init_payment.php;25;test;{merchant};23;molbulak;{secret}
    const fields = { pg_order_id: '23', pg_merchant_id: '545', pg_amount: '25', pg_description: 'test', pg_salt: 'molbulak' };
    const expected = createHash('md5').update('init_payment.php;25;test;545;23;molbulak;secret-key').digest('hex');
    assert.equal(freedomSignature('init_payment.php', fields, 'secret-key'), expected);
  });

  it('creates a payment and checks the signed answer', async () => {
    let sent: URLSearchParams | null = null;
    const answer = (sig: string) => `<?xml version="1.0"?><response><pg_status>ok</pg_status><pg_payment_id>777</pg_payment_id><pg_redirect_url>https://customer.freedompay.kz/pay/777</pg_redirect_url><pg_redirect_url_type>need data</pg_redirect_url_type><pg_salt>abc</pg_salt><pg_sig>${sig}</pg_sig></response>`;
    const good = freedomSignature('init_payment.php', { pg_status: 'ok', pg_payment_id: '777', pg_redirect_url: 'https://customer.freedompay.kz/pay/777', pg_redirect_url_type: 'need data', pg_salt: 'abc' }, config.secret);
    const fetchOk = (async (_url: string, init: RequestInit) => { sent = init.body as URLSearchParams; return new Response(answer(good)); }) as unknown as typeof fetch;
    const result = await freedomCheckout(config, { orderId: 'o1', amountTiyn: 500_000, description: 'Пополнение', resultUrl, successUrl: 'https://app/s', failureUrl: 'https://app/f', email: null }, fetchOk);
    assert.deepEqual(result, { redirectUrl: 'https://customer.freedompay.kz/pay/777', providerPaymentId: '777' });
    const params = Object.fromEntries(sent!.entries());
    assert.equal(params.pg_amount, '5000.00'); assert.equal(params.pg_currency, 'KZT'); assert.equal(params.pg_testing_mode, '1');
    assert.equal(params.pg_sig, freedomSignature('init_payment.php', params, config.secret));
    const fetchForged = (async () => new Response(answer('0'.repeat(32)))) as unknown as typeof fetch;
    await assert.rejects(freedomCheckout(config, { orderId: 'o1', amountTiyn: 500_000, description: 'x', resultUrl, successUrl: 'https://a', failureUrl: 'https://b', email: null }, fetchForged),
      (error: PaymentProviderError) => error.code === 'PAYMENT_PROVIDER_SIGNATURE');
  });

  it('accepts only a correctly signed callback for this result address', () => {
    const fields: Record<string, string> = { pg_order_id: 'o1', pg_payment_id: '777', pg_amount: '5000.00', pg_currency: 'KZT', pg_result: '1', pg_can_reject: '1', pg_salt: 'xyz' };
    fields.pg_sig = freedomSignature('result', fields, config.secret);
    assert.deepEqual(freedomCallback(config, resultUrl, fields), { orderId: 'o1', providerPaymentId: '777', status: 'paid', amountTiyn: 500_000, currency: 'KZT' });
    assert.throws(() => freedomCallback(config, resultUrl, { ...fields, pg_amount: '9999.00' }), PaymentProviderError);
    assert.throws(() => freedomCallback(config, resultUrl, { ...fields, pg_sig: undefined as unknown as string }), PaymentProviderError);
    assert.equal(freedomCallback(config, resultUrl, { ...fields, pg_result: '0', pg_sig: freedomSignature('result', { ...fields, pg_result: '0' }, config.secret) }).status, 'failed');
  });

  it('answers the callback with signed XML', () => {
    const xml = freedomReply(config, resultUrl, 'ok', 'Платёж принят');
    const salt = /<pg_salt>([^<]+)<\/pg_salt>/.exec(xml)![1]!;
    const sig = /<pg_sig>([^<]+)<\/pg_sig>/.exec(xml)![1]!;
    assert.equal(sig, freedomSignature('result', { pg_status: 'ok', pg_description: 'Платёж принят', pg_salt: salt }, config.secret));
  });

  it('never uses the mock provider in production', () => {
    assert.equal(activeProvider({ PAYMENTS_PROVIDER: 'mock', NODE_ENV: 'production' }), null);
    assert.equal(activeProvider({ PAYMENTS_PROVIDER: 'mock' }), 'mock');
    assert.equal(activeProvider({}), null);
    assert.equal(activeProvider({ FREEDOMPAY_MERCHANT_ID: '1', FREEDOMPAY_SECRET_KEY: 's' }), 'freedompay');
  });
});
