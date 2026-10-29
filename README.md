# OrderFlow — Node.js + MySQL + Kafka + Payment Microservices

A local learning project focused on Kafka event-driven order/payment processing. Login, product catalog, order APIs and the UI are included so you can focus on Kafka and payment integration.

## Services

| Service | Port | Responsibility | MySQL tables it owns in this local learning setup |
|---|---:|---|---|
| UI gateway | 3000 | Serves the frontend | None |
| Auth service | 3001 | Register, login, JWT | `users` |
| Product service | 3002 | List/create products | `products` |
| Order service | 3003 | Create/list orders, update order status from Kafka events | `orders`, `order_items`, `processed_payment_events` |
| Payment service | 3004 | Mock payments by default; optional Razorpay Test Mode | `payment_sessions` |
| Existing Kafka broker | 9092 | Event streaming | N/A |

For simple local development these services connect to one MySQL server and one schema (`orderflow`), while tables are logically owned by services. Production deployments should isolate service databases and use a transactional outbox, durable retry/DLQ policies, rate limiting and stronger operational controls.

## Requirements

- Node.js 20+ (Node.js 24 is suitable)
- MySQL Server 8.x running locally on port 3306 (MySQL Workbench alone is only the GUI; it needs a server)
- Your existing Kafka broker running at `localhost:9092` in KRaft mode
- Internet only if you enable Razorpay Checkout or load Google Fonts
- Razorpay Test API keys only if you switch from mock mode to Razorpay Test Mode

## Windows: first-time setup

1. Start MySQL Server in Windows Services or your MySQL setup tool. Make sure you know the MySQL username and password.
2. Open `.env` in the project root and set the MySQL connection values:

   ```env
   DB_HOST=127.0.0.1
   DB_PORT=3306
   DB_USER=root
   DB_PASSWORD=your_mysql_password
   DB_NAME=orderflow
   ```

   If the local MySQL `root` account has no password, leave `DB_PASSWORD=` blank. Do not put quote marks around the password unless the quote marks are part of the actual password.

3. Start your Kafka broker in its own CMD and leave it running:

   ```bat
   cd C:\kafka_2.13-4.3.1
   bin\windows\kafka-server-start.bat config\server.properties
   ```

4. In the project folder, install the updated dependencies (includes `mysql2`):

   ```powershell
   npm.cmd install
   ```

5. Create the MySQL database, tables, and starter products:

   ```powershell
   npm.cmd run db:setup
   ```

   The setup script creates the `orderflow` database if it does not exist, creates the tables, and inserts the sample products if their IDs are not already present. The MySQL account must have permission to create a database and tables. If it does not, create the database manually in Workbench and rerun setup with an appropriately privileged account.

6. Create the Kafka event topics (Kafka must be running first):

   ```powershell
   npm.cmd run topics:create
   ```

7. Start all services:

   ```powershell
   npm.cmd run dev
   ```

8. Open **http://localhost:3000**. Register an account, create/list products, place an order, and choose simulated payment success or failure.

**Important after moving from the older JSON-backed version:** new account/product/order/payment records are stored in MySQL. Existing records in `data/*.json` are not automatically migrated. Register a fresh test account in the updated version.

## Verify the database connection

These health endpoints report `database: "connected"` when MySQL is reachable:

- http://localhost:3001/health
- http://localhost:3002/health
- http://localhost:3003/health
- http://localhost:3004/health

In MySQL Workbench, run:

```sql
USE orderflow;
SHOW TABLES;
SELECT id, name, email, created_at FROM users;
SELECT id, name, price, stock FROM products;
SELECT id, user_id, total_amount, status, created_at FROM orders ORDER BY created_at DESC;
SELECT id, order_id, provider, status, event_id FROM payment_sessions ORDER BY created_at DESC;
```

## Kafka events

| Topic | Producer | Consumer | Key |
|---|---|---|---|
| `orders.created` | order-service | Available for future inventory/analytics consumers | application order ID |
| `payments.succeeded` | payment-service | order-service | application order ID |
| `payments.failed` | payment-service | order-service | application order ID |

Messages are JSON envelopes with `eventId`, `occurredAt`, and event fields. Using the order ID as message key routes events for the same order to the same partition under the configured partitioner. The `processed_payment_events` MySQL table has a unique `event_id` primary key, so duplicate payment events are not applied twice by the order consumer.

## Payment modes

### Option A — Mock mode (default; no gateway account needed)

Keep `PAYMENT_PROVIDER=mock` in `.env`. The checkout offers **Simulate success** and **Simulate failure**. This is a local simulator, not a real payment gateway; it publishes the same Kafka payment events so you can learn the event flow without money movement.

### Option B — Razorpay Test Mode (no real money)

1. Create/sign into a Razorpay account and switch its dashboard to **Test Mode**.
2. Generate Test API keys.
3. Change `.env`:

   ```env
   PAYMENT_PROVIDER=razorpay
   RAZORPAY_KEY_ID=rzp_test_your_test_key_id
   RAZORPAY_KEY_SECRET=your_test_key_secret
   ```

4. Stop and restart `npm.cmd run dev`.
5. Use checkout. The server verifies the payment signature, checks the provider payment/order/amount, captures authorized payments, then publishes `payments.succeeded` to Kafka.

Never put `RAZORPAY_KEY_SECRET` in the browser. Never use Live API keys for this learning project. Read [Razorpay Node.js integration](https://razorpay.com/docs/server-integration/nodejs/).

## API quick reference

- `POST /api/auth/register` — `{name,email,password}`
- `POST /api/auth/login` — `{email,password}`
- `GET /api/products`
- `GET /api/products/:id`
- `POST /api/products` — authenticated; `{name,description,price,stock,emoji}`
- `POST /api/orders` — authenticated; `{productId,quantity}`; optional `Idempotency-Key` header
- `GET /api/orders` — authenticated, current user's orders
- `GET /api/orders/:id` — authenticated, current user's order
- `POST /api/payments/create-order` — authenticated; `{orderId}`
- `POST /api/payments/mock/complete` — mock mode only; `{paymentSessionId,outcome:"success"|"failure"}`
- `POST /api/payments/razorpay/verify` — Razorpay mode only; server-side checkout verification

Each service API runs on ports 3001–3004; the UI on port 3000 calls them directly with CORS enabled.
