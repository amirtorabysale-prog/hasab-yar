import test from 'node:test';
import assert from 'node:assert/strict';
import { extractReceiptData } from '../server/receiptOcr.js';

test('sends a private image request and normalizes structured receipt facts', async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key';
  let requestBody;
  globalThis.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return new Response(JSON.stringify({ output: [{ content: [{ type: 'output_text', text: JSON.stringify({
      amount: 850_000, occurredAt: '2026-08-24T12:30:00Z', merchant: 'فروشگاه نمونه', type: 'expense',
      paymentMethod: 'کارت', reference: '۱۲۳۴', category: 'مواد و کالا', currencySource: 'toman', confidence: 0.91,
      fieldConfidence: { amount: 0.97, occurredAt: 0.8, merchant: 0.9, type: 0.95, paymentMethod: 0.75 }, rawText: 'جمع کل ۸۵۰۰۰۰ تومان',
    }) }] }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const result = await extractReceiptData({ buffer: Buffer.from('readable-image'), mimeType: 'image/jpeg', categories: [{ name: 'مواد و کالا' }] });
    assert.equal(result.amount, 850_000);
    assert.equal(result.merchant, 'فروشگاه نمونه');
    assert.equal(result.status, 'ready');
    assert.equal(requestBody.store, false);
    assert.equal(requestBody.text.format.strict, true);
    assert.match(requestBody.input[0].content[1].image_url, /^data:image\/jpeg;base64,/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey == null) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = originalKey;
  }
});

test('fails safely when receipt OCR is not configured', async () => {
  const originalKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    await assert.rejects(() => extractReceiptData({ buffer: Buffer.from('image'), mimeType: 'image/png' }), (error) => error.code === 'RECEIPT_OCR_UNAVAILABLE');
  } finally {
    if (originalKey != null) process.env.OPENAI_API_KEY = originalKey;
  }
});
