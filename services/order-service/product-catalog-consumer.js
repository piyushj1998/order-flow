require('dotenv').config({
  path: require('node:path').resolve(__dirname, '../../.env'),
});

const { pool } = require('../../shared/db');
const { createEventBus } = require('../../shared/kafka');

const eventBus = createEventBus('product-catalog-consumer');

// Step 1: Kafka se receive hue product event ko process karna
async function handleProductCreated({ topic, payload, partition, offset }) {
  if (topic !== 'products.created') return;

  console.log('[Consumer] Product event received:', payload.eventId);

  const product = payload.product;

  if (!product || !product.id || !product.name) {
    throw new Error('Invalid product event: product details missing');
  }

  // Step 2: Product ko MySQL read-model table mein save/update karna
  const [result] = await pool.execute(
    `INSERT INTO order_product_catalog
      (product_id, name, description, price, stock, emoji, active, last_event_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       name = VALUES(name),
       description = VALUES(description),
       price = VALUES(price),
       stock = VALUES(stock),
       emoji = VALUES(emoji),
       active = VALUES(active),
       last_event_id = VALUES(last_event_id)`,
    [
      String(product.id),
      product.name,
      product.description || '',
      product.price,
      product.stock ?? 0,
      product.emoji || '📦',
      product.active === false ? 0 : 1,
      payload.eventId,
    ]
  );

  console.log('[Consumer] Product saved in MySQL:', product.name);
  console.log('[Consumer] Partition:', partition, '| Offset:', offset);
  console.log('[Consumer] Rows affected:', result.affectedRows);
}

// Step 3: Actual Kafka Consumer ko start karna
async function main() {
  console.log('[Consumer] Starting...');

  await eventBus.startConsumer({
    groupId: 'product-catalog-consumer-group',
    topics: ['products.created'],
    onEvent: handleProductCreated,
  });
}

main().catch((error) => {
  console.error('[Consumer] Fatal error:', error);
  process.exitCode = 1;
});