require('dotenv').config({ path: require('node:path').resolve(__dirname, '../.env') });
const mysql = require('mysql2/promise');

const host = process.env.DB_HOST || '127.0.0.1';
const port = Number(process.env.DB_PORT || 3306);
const user = process.env.DB_USER || 'root';
const password = process.env.DB_PASSWORD || '';
const database = process.env.DB_NAME || 'orderflow';

if (!/^[A-Za-z0-9_]+$/.test(database)) {
  throw new Error('DB_NAME may contain only letters, numbers, and underscores.');
}

const statements = [
  `CREATE TABLE IF NOT EXISTS users (
    id VARCHAR(64) PRIMARY KEY,
    name VARCHAR(120) NOT NULL,
    email VARCHAR(254) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE KEY uq_users_email (email)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS products (
    id VARCHAR(64) PRIMARY KEY,
    name VARCHAR(160) NOT NULL,
    description TEXT NULL,
    price DECIMAL(12,2) NOT NULL,
    stock INT UNSIGNED NOT NULL DEFAULT 0,
    emoji VARCHAR(16) NOT NULL DEFAULT '📦',
    active TINYINT(1) NOT NULL DEFAULT 1,
    created_by VARCHAR(64) NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    KEY ix_products_active_created (active, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS orders (
    id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL,
    user_email VARCHAR(254) NOT NULL,
    total_amount DECIMAL(12,2) NOT NULL,
    currency CHAR(3) NOT NULL DEFAULT 'INR',
    status VARCHAR(32) NOT NULL DEFAULT 'PENDING_PAYMENT',
    payment JSON NULL,
    idempotency_key VARCHAR(120) NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    UNIQUE KEY uq_orders_user_idempotency (user_id, idempotency_key),
    KEY ix_orders_user_created (user_id, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS order_items (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    order_id VARCHAR(64) NOT NULL,
    product_id VARCHAR(64) NOT NULL,
    name VARCHAR(160) NOT NULL,
    unit_price DECIMAL(12,2) NOT NULL,
    quantity INT UNSIGNED NOT NULL,
    line_total DECIMAL(12,2) NOT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    KEY ix_order_items_order (order_id),
    CONSTRAINT fk_order_items_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS payment_sessions (
    id VARCHAR(64) PRIMARY KEY,
    order_id VARCHAR(64) NOT NULL,
    user_id VARCHAR(64) NOT NULL,
    amount_paise BIGINT UNSIGNED NOT NULL,
    currency CHAR(3) NOT NULL DEFAULT 'INR',
    provider VARCHAR(24) NOT NULL,
    provider_order_id VARCHAR(128) NOT NULL,
    provider_payment_id VARCHAR(128) NULL,
    status VARCHAR(24) NOT NULL DEFAULT 'CREATED',
    event_id VARCHAR(64) NULL,
    failure_reason TEXT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    completed_at DATETIME(3) NULL,
    KEY ix_payment_sessions_order (order_id),
    KEY ix_payment_sessions_user (user_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS processed_payment_events (
    event_id VARCHAR(64) PRIMARY KEY,
    order_id VARCHAR(64) NOT NULL,
    topic VARCHAR(128) NOT NULL,
    processed_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    KEY ix_processed_events_order (order_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
];

const seedProducts = [
  ['prd_laptop', 'Everyday Laptop', 'A versatile laptop for work and study.', 55999, 12, '💻'],
  ['prd_headphones', 'Wireless Headphones', 'Comfortable headphones for daily listening.', 2999, 35, '🎧'],
  ['prd_keyboard', 'Mechanical Keyboard', 'Tactile keyboard for coding and productivity.', 4599, 20, '⌨️'],
];

async function main() {
  let admin;
  let connection;
  try {
    admin = await mysql.createConnection({ host, port, user, password, charset: 'utf8mb4' });
    await admin.query(`CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    connection = await mysql.createConnection({ host, port, user, password, database, charset: 'utf8mb4' });
    for (const statement of statements) await connection.query(statement);
    await connection.query(
      `INSERT IGNORE INTO products (id, name, description, price, stock, emoji) VALUES ?`,
      [seedProducts]
    );
    console.log(`MySQL database '${database}' is ready at ${host}:${port}.`);
    console.log('Tables created: users, products, orders, order_items, payment_sessions, processed_payment_events.');
    console.log('Sample products inserted if they did not already exist.');
  } catch (error) {
    console.error('Database setup failed:', error.message);
    console.error('Check that MySQL Server is running and DB_HOST, DB_PORT, DB_USER, DB_PASSWORD are correct in .env.');
    process.exitCode = 1;
  } finally {
    if (connection) await connection.end();
    if (admin) await admin.end();
  }
}

main();
