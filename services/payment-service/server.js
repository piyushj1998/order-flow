require('dotenv').config({ path: require('node:path').resolve(__dirname, '../../.env') });
const express = require('express');
const cors = require('cors');
const crypto = require('node:crypto');
const Razorpay = require('razorpay');
const { randomUUID } = require('node:crypto');
const { pool, pingDatabase, toIso } = require('../../shared/db');
const { requireAuth } = require('../../shared/auth');
const { createEventBus } = require('../../shared/kafka');

const app = express();
const port = Number(process.env.PAYMENT_PORT || 3004);
const provider = String(process.env.PAYMENT_PROVIDER || 'mock').toLowerCase();
const orderServiceUrl = process.env.ORDER_SERVICE_URL || 'http://localhost:3003';
const eventBus = createEventBus('payment-service');
app.use(cors());
app.use(express.json({ limit: '100kb' }));

let razorpay = null;
if (provider === 'razorpay') {
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
    throw new Error('PAYMENT_PROVIDER=razorpay requires RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in .env. Use TEST keys only.');
  }
  razorpay = new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET });
} else if (provider !== 'mock') {
  throw new Error('PAYMENT_PROVIDER must be mock or razorpay.');
}

function mapSession(row) {
  if (!row) return null;
  return {
    id: row.id,
    orderId: row.orderId,
    userId: row.userId,
    amountPaise: Number(row.amountPaise),
    currency: row.currency,
    provider: row.provider,
    providerOrderId: row.providerOrderId,
    providerPaymentId: row.providerPaymentId || null,
    status: row.status,
    eventId: row.eventId || null,
    failureReason: row.failureReason || null,
    createdAt: toIso(row.createdAt),
    completedAt: toIso(row.completedAt),
  };
}

async function findSession(sessionId, userId, orderId = null) {
  const sql = `SELECT id, order_id AS orderId, user_id AS userId, amount_paise AS amountPaise,
      currency, provider, provider_order_id AS providerOrderId,
      provider_payment_id AS providerPaymentId, status, event_id AS eventId,
      failure_reason AS failureReason, created_at AS createdAt, completed_at AS completedAt
    FROM payment_sessions WHERE id = ? AND user_id = ?${orderId ? ' AND order_id = ?' : ''} LIMIT 1`;
  const params = orderId ? [sessionId, userId, orderId] : [sessionId, userId];
  const [rows] = await pool.execute(sql, params);
  return mapSession(rows[0]);
}

app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ service: 'payment-service', status: 'ok', provider, database: 'connected' });
  } catch {
    res.status(503).json({ service: 'payment-service', status: 'degraded', provider, database: 'disconnected' });
  }
});

async function getOwnedOrder(orderId, authorization) {
  const response = await fetch(`${orderServiceUrl}/api/orders/${encodeURIComponent(orderId)}`, { headers: { Authorization: authorization || '' } });
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(payload.error || 'Could not load order.');
    error.status = response.status;
    throw error;
  }
  return payload.order;
}

app.post('/api/payments/create-order', requireAuth, async (req, res) => {
  const orderId = String(req.body.orderId || '');
  if (!orderId) return res.status(400).json({ error: 'orderId is required.' });
  let order;
  try { order = await getOwnedOrder(orderId, req.headers.authorization); }
  catch (error) { return res.status(error.status || 503).json({ error: error.message }); }
  if (!['PENDING_PAYMENT', 'PAYMENT_FAILED'].includes(order.status)) return res.status(409).json({ error: `This order cannot be paid in status ${order.status}.` });

  const amountPaise = Math.round(Number(order.totalAmount) * 100);
  let session;
  if (provider === 'razorpay') {
    try {
      const gatewayOrder = await razorpay.orders.create({
        amount: amountPaise,
        currency: 'INR',
        receipt: order.id.slice(0, 40),
        notes: { applicationOrderId: order.id, userId: req.user.id },
      });
      session = { id: `pays_${randomUUID().slice(0, 12)}`, orderId: order.id, userId: req.user.id, amountPaise, currency: 'INR', provider, providerOrderId: gatewayOrder.id, status: 'CREATED' };
    } catch (error) {
      console.error('[payment-service] Razorpay order creation failed:', error.message);
      return res.status(502).json({ error: 'Razorpay could not create a test order. Check test credentials and try again.' });
    }
  } else {
    session = { id: `mock_${randomUUID().slice(0, 12)}`, orderId: order.id, userId: req.user.id, amountPaise, currency: 'INR', provider: 'mock', providerOrderId: `mock_order_${randomUUID().slice(0, 10)}`, status: 'CREATED' };
  }

  try {
    await pool.execute(
      `INSERT INTO payment_sessions (id, order_id, user_id, amount_paise, currency, provider, provider_order_id, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'CREATED', NOW(3))`,
      [session.id, session.orderId, session.userId, session.amountPaise, session.currency, session.provider, session.providerOrderId]
    );
    return res.status(201).json({
      provider: session.provider,
      applicationOrderId: order.id,
      paymentSessionId: session.id,
      providerOrderId: session.providerOrderId,
      amount: amountPaise,
      currency: 'INR',
      keyId: provider === 'razorpay' ? process.env.RAZORPAY_KEY_ID : null,
      productName: order.items.map((item) => item.name).join(', '),
    });
  } catch (error) {
    console.error('[payment-service] Could not save payment session to MySQL:', error.message);
    return res.status(500).json({ error: 'Could not save payment session to MySQL.' });
  }
});

app.post('/api/payments/mock/complete', requireAuth, async (req, res) => {
  if (provider !== 'mock') return res.status(404).json({ error: 'Mock payments are disabled. Use Razorpay Checkout.' });
  const { paymentSessionId, outcome } = req.body;
  if (!paymentSessionId || !['success', 'failure'].includes(outcome)) return res.status(400).json({ error: 'paymentSessionId and outcome (success/failure) are required.' });

  let session;
  try { session = await findSession(paymentSessionId, req.user.id); }
  catch (error) {
    console.error('[payment-service] Could not load payment session:', error.message);
    return res.status(500).json({ error: 'Could not load payment session from MySQL.' });
  }
  if (!session) return res.status(404).json({ error: 'Payment session not found.' });
  if (session.status !== 'CREATED') return res.status(409).json({ error: 'This payment session was already completed.' });

  const succeeded = outcome === 'success';
  const providerPaymentId = succeeded ? `mock_pay_${randomUUID().slice(0, 10)}` : null;
  try {
    const event = await eventBus.publish(succeeded ? 'payments.succeeded' : 'payments.failed', session.orderId, {
      eventType: succeeded ? 'payment.succeeded' : 'payment.failed',
      orderId: session.orderId, userId: session.userId, provider: 'mock',
      providerOrderId: session.providerOrderId, providerPaymentId,
      amount: session.amountPaise / 100, currency: session.currency,
      reason: succeeded ? undefined : 'Simulated test payment failure',
    });
    const status = succeeded ? 'SUCCEEDED' : 'FAILED';
    await pool.execute(
      `UPDATE payment_sessions SET status = ?, event_id = ?, provider_payment_id = ?,
       failure_reason = ?, completed_at = NOW(3) WHERE id = ? AND status = 'CREATED'`,
      [status, event.eventId, providerPaymentId,
        succeeded ? null : 'Simulated test payment failure', session.id]
    );
    return res.json({ accepted: true, status, message: 'Payment result was published to Kafka; order status updates asynchronously.' });
  } catch (error) {
    console.error('[payment-service] Could not complete mock payment:', error.message);
    return res.status(503).json({ error: 'Payment result could not be completed. Check Kafka, MySQL, and the payment-service logs.' });
  }
});

app.post('/api/payments/razorpay/verify', requireAuth, async (req, res) => {
  if (provider !== 'razorpay') return res.status(404).json({ error: 'Razorpay is not enabled.' });
  const { applicationOrderId, paymentSessionId, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
  if (!applicationOrderId || !paymentSessionId || !razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return res.status(400).json({ error: 'Missing Razorpay payment verification fields.' });
  }

  let session;
  try { session = await findSession(paymentSessionId, req.user.id, applicationOrderId); }
  catch (error) {
    console.error('[payment-service] Could not load payment session:', error.message);
    return res.status(500).json({ error: 'Could not load payment session from MySQL.' });
  }
  if (!session) return res.status(404).json({ error: 'Payment session not found.' });
  if (session.providerOrderId !== razorpay_order_id) return res.status(400).json({ error: 'Razorpay order id does not match the server-side payment session.' });
  if (session.status === 'SUCCEEDED') return res.json({ accepted: true, status: 'SUCCEEDED', message: 'Payment was already verified.' });

  const expected = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(`${session.providerOrderId}|${razorpay_payment_id}`).digest('hex');
  const expectedBuffer = Buffer.from(expected, 'hex');
  const receivedBuffer = /^[a-f0-9]{64}$/i.test(razorpay_signature) ? Buffer.from(razorpay_signature, 'hex') : Buffer.alloc(0);
  if (expectedBuffer.length !== receivedBuffer.length || !crypto.timingSafeEqual(expectedBuffer, receivedBuffer)) {
    return res.status(400).json({ error: 'Payment signature verification failed.' });
  }

  try {
    let payment = await razorpay.payments.fetch(razorpay_payment_id);
    if (payment.order_id !== session.providerOrderId || Number(payment.amount) !== session.amountPaise) {
      return res.status(400).json({ error: 'Payment order or amount does not match the stored checkout session.' });
    }
    if (payment.status === 'authorized') {
      payment = await razorpay.payments.capture(razorpay_payment_id, session.amountPaise, session.currency);
    }
    if (payment.status !== 'captured') {
      return res.status(409).json({ error: `Payment is not captured yet (current status: ${payment.status}).` });
    }

    const event = await eventBus.publish('payments.succeeded', session.orderId, {
      eventType: 'payment.succeeded', orderId: session.orderId, userId: session.userId,
      provider: 'razorpay', providerOrderId: session.providerOrderId, providerPaymentId: razorpay_payment_id,
      amount: session.amountPaise / 100, currency: session.currency,
    });
    await pool.execute(
      `UPDATE payment_sessions SET status = 'SUCCEEDED', event_id = ?, provider_payment_id = ?,
       completed_at = NOW(3) WHERE id = ?`,
      [event.eventId, razorpay_payment_id, session.id]
    );
    return res.json({ accepted: true, status: 'SUCCEEDED', message: 'Payment signature and captured status verified; payment.succeeded published to Kafka.' });
  } catch (error) {
    console.error('[payment-service] Razorpay verification failed:', error.message);
    return res.status(502).json({ error: 'Could not verify/capture the Razorpay test payment. Check payment status, MySQL and server logs.' });
  }
});

async function start() {
  try {
    await pingDatabase();
    app.listen(port, () => console.log(`[payment-service] listening on http://localhost:${port} (provider: ${provider}; MySQL connected)`));
  } catch (error) {
    console.error(`[payment-service] MySQL connection failed: ${error.message}`);
    console.error('Run `npm.cmd run db:setup` and check DB_* values in .env.');
    process.exit(1);
  }
}
start();
