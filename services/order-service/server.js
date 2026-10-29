require('dotenv').config({ path: require('node:path').resolve(__dirname, '../../.env') });
const express = require('express');
const cors = require('cors');
const { randomUUID } = require('node:crypto');
const { pool, pingDatabase, withTransaction, toIso, parseJson } = require('../../shared/db');
const { requireAuth } = require('../../shared/auth');
const { createEventBus } = require('../../shared/kafka');
const app = express();
const port = Number(process.env.ORDER_PORT || 3003);
const productServiceUrl = process.env.PRODUCT_SERVICE_URL || 'http://localhost:3002';
const eventBus = createEventBus('order-service');
app.use(cors());
app.use(express.json({ limit: '100kb' }));

function mapOrder(row, items = []) {
  return {
    id: row.id,
    userId: row.userId,
    userEmail: row.userEmail,
    items,
    totalAmount: Number(row.totalAmount),
    currency: row.currency,
    status: row.status,
    payment: parseJson(row.payment, null),
    idempotencyKey: row.idempotencyKey || null,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}

async function getOrder(orderId, userId = null, connection = pool) {
  const sql = `SELECT id, user_id AS userId, user_email AS userEmail, total_amount AS totalAmount,
      currency, status, payment, idempotency_key AS idempotencyKey,
      created_at AS createdAt, updated_at AS updatedAt
    FROM orders WHERE id = ?${userId ? ' AND user_id = ?' : ''} LIMIT 1`;
  const params = userId ? [orderId, userId] : [orderId];
  const [rows] = await connection.execute(sql, params);
  if (!rows[0]) return null;
  const [itemRows] = await connection.execute(
    `SELECT product_id AS productId, name, unit_price AS unitPrice, quantity, line_total AS lineTotal
     FROM order_items WHERE order_id = ? ORDER BY id`, [orderId]
  );
  const items = itemRows.map((item) => ({
    productId: item.productId,
    name: item.name,
    unitPrice: Number(item.unitPrice),
    quantity: Number(item.quantity),
    lineTotal: Number(item.lineTotal),
  }));
  return mapOrder(rows[0], items);
}

app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ service: 'order-service', status: 'ok', database: 'connected' });
  } catch {
    res.status(503).json({ service: 'order-service', status: 'degraded', database: 'disconnected' });
  }
});


app.post('/api/cart/items', requireAuth, async (req, res) => {
  const productId = String(req.body.productId || '').trim();
  const quantity = Number(req.body.quantity ?? 1);
  const userId = String(req.user.id);
  const idempotencyKey = String(
    req.get('Idempotency-Key') || ''
  ).trim();

  if (!productId) {
    return res.status(400).json({ error: 'productId is required.' });
  }

  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 20) {
    return res.status(400).json({
      error: 'Quantity must be between 1 and 20.',
    });
  }

  if (!idempotencyKey || idempotencyKey.length > 120) {
    return res.status(400).json({
      error: 'A valid Idempotency-Key header is required.',
    });
  }

  const requestHash = require('node:crypto')
    .createHash('sha256')
    .update(JSON.stringify({ productId, quantity }))
    .digest('hex');

  async function recordFailure(statusCode, message) {
    const body = { error: message };

    await pool.execute(
      `UPDATE idempotency_keys
       SET status = 'FAILED', response_json = ?
       WHERE user_id = ? AND idempotency_key = ?`,
      [
        JSON.stringify({ statusCode, body }),
        userId,
        idempotencyKey,
      ]
    );

    return res.status(statusCode).json(body);
  }

  let eventPublished = false;

  try {
    // Register this key. The primary key prevents duplicate registration.
    const [insertResult] = await pool.execute(
      `INSERT IGNORE INTO idempotency_keys
       (user_id, idempotency_key, request_hash, status)
       VALUES (?, ?, ?, 'PROCESSING')`,
      [userId, idempotencyKey, requestHash]
    );

    const [rows] = await pool.execute(
      `SELECT request_hash, status, event_id, response_json
       FROM idempotency_keys
       WHERE user_id = ? AND idempotency_key = ?`,
      [userId, idempotencyKey]
    );

    const saved = rows[0];

    if (!saved) {
      throw new Error('Could not read idempotency record.');
    }

    // Never allow the same key to represent a different request.
    if (saved.request_hash !== requestHash) {
      return res.status(409).json({
        error: 'This Idempotency-Key was already used for a different request.',
      });
    }

    // This key already exists: do not publish the event again.
    if (insertResult.affectedRows === 0) {
      let previous = saved.response_json;

      if (typeof previous === 'string') {
        try {
          previous = JSON.parse(previous);
        } catch {
          previous = null;
        }
      }

      if (saved.status === 'PUBLISHED') {
        return res.status(202).json(
          previous || {
            message: 'Cart event already published.',
            eventId: saved.event_id,
            status: 'PUBLISHED',
          }
        );
      }

      if (saved.status === 'FAILED') {
        return res
          .status(previous?.statusCode || 503)
          .json(previous?.body || { error: 'Previous request failed.' });
      }

      return res.status(202).json({
        message: 'This request is already being processed.',
        eventId: saved.event_id,
        status: 'PENDING_SYNC',
      });
    }

    // Verify that the product exists.
    const productServiceUrl =
      process.env.PRODUCT_SERVICE_URL || 'http://localhost:3002';

    const productResponse = await fetch(
      `${productServiceUrl}/api/products/${encodeURIComponent(productId)}`
    );

    const productResult = await productResponse.json();

    if (!productResponse.ok) {
      return await recordFailure(
        productResponse.status,
        productResult.error || 'Could not find product.'
      );
    }

    const product = productResult.product;

    if (quantity > product.stock) {
      return await recordFailure(
        400,
        'Requested quantity exceeds available stock.'
      );
    }

    // Publish the cart event to Kafka.
    const event = await eventBus.publish(
      'cart.item_added',
      `${userId}:${product.id}`,
      {
        eventType: 'cart.item_added',
        userId,
        productId: product.id,
        quantity,
        product: {
          id: product.id,
          name: product.name,
          price: product.price,
          emoji: product.emoji,
        },
      }
    );

    eventPublished = true;

    const responseBody = {
      message: 'Cart item event published. Waiting for consumer to sync.',
      eventId: event.eventId,
      status: 'PENDING_SYNC',
    };

    await pool.execute(
      `UPDATE idempotency_keys
       SET status = 'PUBLISHED',
           event_id = ?,
           response_json = ?
       WHERE user_id = ? AND idempotency_key = ?`,
      [
        event.eventId,
        JSON.stringify(responseBody),
        userId,
        idempotencyKey,
      ]
    );

    console.log(
      `[order-service] Published cart.item_added: user=${userId}, ` +
      `product=${product.id}, event=${event.eventId}`
    );

    return res.status(202).json(responseBody);
  } catch (error) {
    console.error('[order-service] Add-to-cart failed:', error.message);

    // Kafka may already have received the event. Do not mark it FAILED
    // or publish it again automatically when the database update fails.
    if (eventPublished) {
      return res.status(202).json({
        message: 'Event was published; sync status may still be pending.',
        status: 'PENDING_SYNC',
      });
    }

    try {
      await recordFailure(503, 'Could not publish cart item event.');
    } catch (dbError) {
      console.error(
        '[order-service] Could not update idempotency record:',
        dbError.message
      );

      return res.status(503).json({
        error: 'Request status could not be saved. Check the existing key before retrying.',
      });
    }
  }
});

// GET products from the Kafka consumer's read-model table
app.get('/api/order-catalog/products', async (_req, res) => {
  try {
const [rows] = await pool.query(`
      SELECT
        id AS id,
        name,
        description,
        price,
        stock,
        emoji,
        active,
        created_at AS syncedAt
      FROM products
      WHERE active = 1
      ORDER BY created_at DESC
    `);

    const products = rows.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description || '',
      price: Number(row.price),
      stock: Number(row.stock),
      emoji: row.emoji || '📦',
      active: Boolean(row.active),
      syncedAt: toIso(row.syncedAt),
    }));

    return res.json({ products });
  } catch (error) {
    console.error(
      '[order-service] catalog fetch failed:',
      error.message
    );

    return res.status(500).json({
      error: 'Could not load products from the order catalog.',
    });
  }
});

app.post('/api/orders', requireAuth, async (req, res) => {
  const productId = String(req.body.productId || '');
  const quantity = Number(req.body.quantity ?? 1);
  if (!productId) return res.status(400).json({ error: 'productId is required.' });
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 20) return res.status(400).json({ error: 'Quantity must be a whole number between 1 and 20.' });

  let product;
  try {
    const response = await fetch(`${productServiceUrl}/api/products/${encodeURIComponent(productId)}`);
    const payload = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: payload.error || 'Could not load product.' });
    product = payload.product;
  } catch {
    return res.status(503).json({ error: 'Product service is unavailable. Check that all services are running.' });
  }
  if (quantity > product.stock) return res.status(400).json({ error: 'Requested quantity exceeds the displayed stock.' });

  const idempotencyKey = String(req.headers['idempotency-key'] || '').slice(0, 120) || null;
  if (idempotencyKey) {
    const [existingRows] = await pool.execute(
      'SELECT id FROM orders WHERE user_id = ? AND idempotency_key = ? LIMIT 1', [req.user.id, idempotencyKey]
    );
    if (existingRows[0]) {
      const existing = await getOrder(existingRows[0].id, req.user.id);
      return res.status(200).json({ order: existing, reused: true });
    }
  }

  const orderId = `ord_${randomUUID().slice(0, 12)}`;
  const lineTotal = Number((Number(product.price) * quantity).toFixed(2));
  try {
    await withTransaction(async (connection) => {
      await connection.execute(
        `INSERT INTO orders (id, user_id, user_email, total_amount, currency, status, payment, idempotency_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'INR', 'PENDING_PAYMENT', NULL, ?, NOW(3), NOW(3))`,
        [orderId, req.user.id, req.user.email, lineTotal, idempotencyKey]
      );
      await connection.execute(
        `INSERT INTO order_items (order_id, product_id, name, unit_price, quantity, line_total)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [orderId, product.id, product.name, Number(product.price), quantity, lineTotal]
      );
    });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY' && idempotencyKey) {
      const [existingRows] = await pool.execute('SELECT id FROM orders WHERE user_id = ? AND idempotency_key = ? LIMIT 1', [req.user.id, idempotencyKey]);
      if (existingRows[0]) return res.status(200).json({ order: await getOrder(existingRows[0].id, req.user.id), reused: true });
    }
    console.error('[order-service] create order failed:', error.message);
    return res.status(500).json({ error: 'Could not save the order to MySQL.' });
  }

  const order = await getOrder(orderId, req.user.id);
  let eventPublished = false;
  try {
    await eventBus.publish('orders.created', order.id, {
      eventType: 'order.created', orderId: order.id, userId: order.userId,
      amount: order.totalAmount, currency: order.currency, items: order.items,
    });
    eventPublished = true;
  } catch (error) {
    console.error(`[order-service] Order ${order.id} saved to MySQL, but orders.created could not be published: ${error.message}`);
  }
  return res.status(201).json({
    order,
    eventPublished,
    warning: eventPublished ? undefined : 'Order is saved in MySQL but its Kafka event was not published. Check Kafka before retrying.',
  });
});

app.get('/api/orders', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT id FROM orders WHERE user_id = ? ORDER BY created_at DESC', [req.user.id]);
    const orders = await Promise.all(rows.map((row) => getOrder(row.id, req.user.id)));
    res.json({ orders });
  } catch (error) {
    console.error('[order-service] list orders failed:', error.message);
    res.status(500).json({ error: 'Could not load orders from MySQL.' });
  }
});

app.get('/api/orders/:id', requireAuth, async (req, res) => {
  try {
    const order = await getOrder(req.params.id, req.user.id);
    if (!order) return res.status(404).json({ error: 'Order not found.' });
    res.json({ order });
  } catch (error) {
    console.error('[order-service] get order failed:', error.message);
    res.status(500).json({ error: 'Could not load order from MySQL.' });
  }
});

async function handlePaymentEvent({ topic, payload }) {
  await withTransaction(async (connection) => {
    const [orderRows] = await connection.execute(
      'SELECT id, status FROM orders WHERE id = ? FOR UPDATE', [payload.orderId]
    );
    if (!orderRows[0]) {
      console.warn(`[order-service] Ignoring ${topic}: order ${payload.orderId} not found.`);
      return;
    }

    const [insertResult] = await connection.execute(
      'INSERT IGNORE INTO processed_payment_events (event_id, order_id, topic) VALUES (?, ?, ?)',
      [payload.eventId, payload.orderId, topic]
    );
    if (insertResult.affectedRows === 0) {
      console.log(`[order-service] Duplicate event ${payload.eventId} ignored.`);
      return;
    }

    const currentStatus = orderRows[0].status;
    let nextStatus = currentStatus;
    let payment = null;
    if (topic === 'payments.succeeded' && currentStatus !== 'PAID') {
      nextStatus = 'PAID';
      payment = {
        provider: payload.provider,
        providerPaymentId: payload.providerPaymentId || null,
        providerOrderId: payload.providerOrderId || null,
        paidAmount: Number(payload.amount),
        currency: payload.currency || 'INR',
        verifiedAt: new Date().toISOString(),
      };
    } else if (topic === 'payments.failed' && currentStatus !== 'PAID') {
      nextStatus = 'PAYMENT_FAILED';
      payment = {
        provider: payload.provider,
        failureReason: payload.reason || 'Payment failed',
        failedAt: new Date().toISOString(),
      };
    }

    if (payment) {
      await connection.execute(
        'UPDATE orders SET status = ?, payment = CAST(? AS JSON), updated_at = NOW(3) WHERE id = ?',
        [nextStatus, JSON.stringify(payment), payload.orderId]
      );
    }
    console.log(`[order-service] Order ${payload.orderId} processed ${topic}; status=${nextStatus}`);
  });
}

async function start() {
  try {
    await pingDatabase();
    app.listen(port, () => {
      console.log(`[order-service] listening on http://localhost:${port} (MySQL connected)`);
      eventBus.startConsumer({
        groupId: 'order-status-updater-v1',
        topics: ['payments.succeeded', 'payments.failed'],
        onEvent: handlePaymentEvent,
      }).catch((error) => console.error('[order-service] Kafka consumer stopped:', error.message));
    });
  } catch (error) {
    console.error(`[order-service] MySQL connection failed: ${error.message}`);
    console.error('Run `npm.cmd run db:setup` and check DB_* values in .env.');
    process.exit(1);
  }
}
start();
