require('dotenv').config({ path: require('node:path').resolve(__dirname, '../../.env') });
const express = require('express');
const cors = require('cors');
const { randomUUID } = require('node:crypto');
const { pool, pingDatabase, toIso } = require('../../shared/db');
const { requireAuth } = require('../../shared/auth');

const app = express();
const port = Number(process.env.PRODUCT_PORT || 3002);
const { createEventBus } = require('../../shared/kafka');
const eventBus = createEventBus('product-service');

app.use(cors());
app.use(express.json({ limit: '100kb' }));

function toProduct(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description || '',
    price: Number(row.price),
    stock: Number(row.stock),
    emoji: row.emoji || '📦',
    active: Boolean(row.active),
    createdAt: toIso(row.createdAt),
    ...(row.createdBy ? { createdBy: row.createdBy } : {}),
  };
}

app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ service: 'product-service', status: 'ok', database: 'connected' });
  } catch {
    res.status(503).json({ service: 'product-service', status: 'degraded', database: 'disconnected' });
  }
});

app.get('/api/products', async (_req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT id, name, description, price, stock, emoji, active, created_by AS createdBy, created_at AS createdAt FROM products WHERE active = 1 ORDER BY created_at DESC'
    );
    console.log(rows)
    res.json({ products: rows.map(toProduct) });
  } catch (error) {
    console.error('[product-service] list failed:', error.message);
    res.status(500).json({ error: 'Could not load products from MySQL.' });
  }
});

app.get('/api/products/:id', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT id, name, description, price, stock, emoji, active, created_by AS createdBy, created_at AS createdAt FROM products WHERE id = ? AND active = 1 LIMIT 1',
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Product not found.' });
    res.json({ product: toProduct(rows[0]) });
  } catch (error) {
    console.error('[product-service] get failed:', error.message);
    res.status(500).json({ error: 'Could not load product from MySQL.' });
  }
});

app.post('/api/products', requireAuth, async (req, res) => {
  const name = String(req.body.name || '').trim();
  const description = String(req.body.description || '').trim();
  const price = Number(req.body.price);
  const stock = Number(req.body.stock ?? 10);
  if (name.length < 2) return res.status(400).json({ error: 'Product name must be at least 2 characters.' });
  if (!Number.isFinite(price) || price <= 0 || Math.round(price * 100) !== price * 100) return res.status(400).json({ error: 'Price must be a positive amount with up to 2 decimal places.' });
  if (!Number.isInteger(stock) || stock < 0) return res.status(400).json({ error: 'Stock must be a non-negative whole number.' });

  const product = {
    id: `prd_${randomUUID().slice(0, 12)}`,
    name,
    description,
    price: Number(price.toFixed(2)),
    stock,
    emoji: String(req.body.emoji || '📦').slice(0, 4),
    active: true,
    createdBy: req.user.id,
  };
  try {
    await pool.execute(
      'INSERT INTO products (id, name, description, price, stock, emoji, active, created_by) VALUES (?, ?, ?, ?, ?, ?, 1, ?)',
      [product.id, product.name, product.description, product.price, product.stock, product.emoji, product.createdBy]
    );
    const [rows] = await pool.execute(
      'SELECT id, name, description, price, stock, emoji, active, created_by AS createdBy, created_at AS createdAt FROM products WHERE id = ?',
      [product.id]
    );

      const createdProduct = toProduct(rows[0]);

      let eventPublished = false;
      let warning;

      try {
        await eventBus.publish('products.created', createdProduct.id, {
          eventType: 'product.created',
          product: createdProduct,
        });

        eventPublished = true;
        console.log(
          `[product-service] Published products.created for ${createdProduct.id}`
        );
      } catch (eventError) {
        warning = 'Product saved in MySQL, but Kafka event was not published.';

        console.error(
          `[product-service] Kafka publish failed for ${createdProduct.id}:`,
          eventError.message
        );
      }

      return res.status(201).json({
        product: createdProduct,
        eventPublished,
        ...(warning ? { warning } : {}),
      });
  } catch (error) {
    console.error('[product-service] create failed:', error.message);
    res.status(500).json({ error: 'Could not create product in MySQL.' });
  }
});

async function start() {
  try {
    await pingDatabase();
    app.listen(port, () => console.log(`[product-service] listening on http://localhost:${port} (MySQL connected)`));
  } catch (error) {
    console.error(`[product-service] MySQL connection failed: ${error.message}`);
    console.error('Run `npm.cmd run db:setup` and check DB_* values in .env.');
    process.exit(1);
  }
}
start();
