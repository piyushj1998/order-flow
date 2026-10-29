require('dotenv').config({
  path: require('node:path').resolve(__dirname, '../../.env'),
});

const { pool } = require('../../shared/db');
const { createEventBus } = require('../../shared/kafka');

const eventBus = createEventBus('cart-consumer');

const CONSUMER_NAME = 'cart-items-consumer';

async function handleCartItemAdded({ topic, payload, partition, offset }) {
  if (topic !== 'cart.item_added') return;

  const eventId = String(payload.eventId || '').trim();
  const userId = String(payload.userId || '').trim();
  const productId = String(payload.productId || '').trim();
  const quantity = Number(payload.quantity ?? 1);

  // Validate event
  if (
    !eventId ||
    !userId ||
    !productId ||
    !Number.isInteger(quantity) ||
    quantity < 1
  ) {
    throw new Error('Invalid cart.item_added event');
  }

  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    // Step 1: Check whether this event was already processed
    const [eventResult] = await connection.execute(
      `INSERT IGNORE INTO processed_events
       (consumer_name, event_id, event_type)
       VALUES (?, ?, ?)`,
      [CONSUMER_NAME, eventId, topic]
    );

    // Duplicate event: do not increment quantity again
    if (eventResult.affectedRows === 0) {
      await connection.rollback();

      console.log(
        `[cart-consumer] Duplicate event skipped: ${eventId}`
      );

      return;
    }

    // Step 2: Insert cart item, or increment existing quantity
    await connection.execute(
      `INSERT INTO cart_items
       (user_id, product_id, quantity)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE
         quantity = quantity + VALUES(quantity),
         updated_at = CURRENT_TIMESTAMP(3)`,
      [userId, productId, quantity]
    );

    // Step 3: Save the cart update and event record together
    await connection.commit();

    console.log('[cart-consumer] Cart item saved in MySQL');
    console.log('User ID:', userId);
    console.log('Product ID:', productId);
    console.log('Quantity added:', quantity);
    console.log('Partition:', partition, '| Offset:', offset);
    console.log('Event ID:', eventId);
  } catch (error) {
    await connection.rollback();

    console.error(
      '[cart-consumer] Database processing failed:',
      error.message
    );

    throw error;
  } finally {
    connection.release();
  }
}

async function main() {
  console.log('[cart-consumer] Starting...');

  await eventBus.startConsumer({
    groupId: 'cart-items-consumer-group',
    topics: ['cart.item_added'],
    onEvent: handleCartItemAdded,
  });
}

main().catch((error) => {
  console.error('[cart-consumer] Fatal error:', error);
  process.exitCode = 1;
});