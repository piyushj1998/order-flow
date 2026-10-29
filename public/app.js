const API = {
  auth: 'http://localhost:3001',
  products: 'http://localhost:3002',
  orders: 'http://localhost:3003',
  payments: 'http://localhost:3004',
};

const state = {
  token: localStorage.getItem('orderflow.token') || '',
  user: JSON.parse(localStorage.getItem('orderflow.user') || 'null'),
  products: [],
  pendingMockPayment: null,
};

const el = (id) => document.getElementById(id);
const money = (amount) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(Number(amount || 0));
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

function showToast(message, isError = false) {
  const toast = el('toast');
  toast.textContent = message;
  toast.classList.toggle('error', isError);
  toast.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('show'), 3600);
}

function setMessage(id, message, isError = false) {
  const node = el(id);
  node.textContent = message;
  node.classList.toggle('error', isError);
}

async function request(base, path, options = {}) {
  const headers = { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}), ...(options.headers || {}) };
  let response;
  try {
    response = await fetch(`${base}${path}`, { ...options, headers });
  } catch {
    throw new Error(`Could not reach ${base}. Is that service running?`);
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status}).`);
  return payload;
}

function saveSession(token, user) {
  state.token = token;
  state.user = user;
  localStorage.setItem('orderflow.token', token);
  localStorage.setItem('orderflow.user', JSON.stringify(user));
  updateAccountUi();
}

function updateAccountUi() {
  const loggedIn = Boolean(state.token && state.user);
  el('user-chip').classList.toggle('hidden', !loggedIn);
  el('user-chip').textContent = loggedIn ? `Hi, ${state.user.name}` : '';
  el('logout-button').classList.toggle('hidden', !loggedIn);
  el('account-link').classList.toggle('hidden', loggedIn);
  el('account-link').textContent = loggedIn ? state.user.name : 'Login / Register';
  el('login-form').classList.toggle('hidden', loggedIn);
  el('register-form').classList.toggle('hidden', loggedIn);
  if (loggedIn) {
    document.querySelector('#account .section-heading h2').textContent = `Welcome, ${state.user.name.split(' ')[0]}`;
    document.querySelector('#account .section-heading p').textContent = 'You are logged in. You can place orders and add products.';
    setMessage('auth-message', `Logged in as ${state.user.email}`);
  } else {
    document.querySelector('#account .section-heading h2').textContent = 'Login to get started';
    document.querySelector('#account .section-heading p').textContent = 'Create an account to place an order or add a product.';
    setMessage('auth-message', '');
  }
}

async function authSubmit(event, mode) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form).entries());
  try {
    const result = await request(API.auth, `/api/auth/${mode}`, { method: 'POST', body: JSON.stringify(data) });
    saveSession(result.token, result.user);
    form.reset();
    showToast(mode === 'login' ? 'You are logged in.' : 'Account created successfully.');
    await loadOrders();
  } catch (error) {
    setMessage('auth-message', error.message, true);
  }
}

async function loadProducts() {
  const grid = el('product-grid');
  grid.innerHTML = '<div class="loading-card">Loading the catalog…</div>';
  try {
    const { products } = await request(
  API.orders,
  '/api/order-catalog/products'
);
    state.products = products;
    el('product-count').textContent = `${products.length} products available`;
    if (!products.length) {
      grid.innerHTML = `
        <div class="loading-card">
          No products have reached the order catalog yet.
          Waiting for the Kafka consumer to sync products.
        </div>
      `;
      return;
    }
    grid.innerHTML = products.map((product) => `
      <article class="product-card">
        <div class="product-art"><span class="stock-badge">${Number(product.stock)} in stock</span><span class="product-emoji">${escapeHtml(product.emoji || '📦')}</span></div>
        <div class="product-info"><div class="product-info-top"><div><h3>${escapeHtml(product.name)}</h3><span class="product-id">${escapeHtml(product.id)}</span></div></div>
          <p class="product-description">${escapeHtml(product.description || 'An everyday essential, ready to order.')}</p>
          <div class="product-bottom"><div class="product-price">${money(product.price)}<small>INR · per item</small></div><button class="button button-primary buy-button" data-buy="${escapeHtml(product.id)}" ${Number(product.stock) < 1 ? 'disabled' : ''}>Add to cart ↗</button></div>
        </div>
      </article>`).join('');
  } catch (error) {
    grid.innerHTML = `<div class="loading-card">${escapeHtml(error.message)}<br><br>Start the services with <code>npm run dev</code>.</div>`;
    el('product-count').textContent = 'Catalog unavailable';
  }
}

async function createProduct(event) {
  event.preventDefault();
  if (!state.token) {
    setMessage('product-message', 'Please login before creating a product.', true);
    location.hash = '#account';
    return;
  }
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form).entries());
  data.price = Number(data.price);
  data.stock = Number(data.stock);
  try {
    const result = await request(API.products, '/api/products', { method: 'POST', body: JSON.stringify(data) });
    setMessage('product-message', `Created ${result.product.name} (${result.product.id}).`);
    showToast('Product created. Waiting for Kafka catalog sync.');
    form.reset();
    form.elements.stock.value = '10';
    form.elements.emoji.value = '📦';
    await loadProducts();
  } catch (error) {
    setMessage('product-message', error.message, true);
  }
}

async function addToCart(productId) {
  if (!state.token) {
    showToast('Login or create an account before adding to cart.', true);
    location.hash = '#account';
    return;
  }

  const button = document.querySelector(
    `[data-buy="${CSS.escape(productId)}"]`
  );

  // Prevent another click while the request is pending
  if (button?.disabled) return;

  const originalText = button?.textContent || 'Add to Cart';

  if (button) {
    button.disabled = true;
    button.textContent = 'Adding...';
  }

  try {
    const result = await request(API.orders, '/api/cart/items', {
      method: 'POST',
      headers: {
        'Idempotency-Key': "6f7b3685-9a41-49ea-a0fe-a9766da0ef9d",
      },
      body: JSON.stringify({
        productId,
        quantity: 1,
      }),
    });

    showToast(
      result.status === 'PENDING_SYNC'
        ? 'Request accepted. Syncing your cart...'
        : 'Product added to cart.'
    );
  } catch (error) {
    showToast(error.message || 'Could not add product to cart.', true);
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = originalText;
    }
  }
}

async function loadRazorpayScript() {
  if (window.Razorpay) return;
  await new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://checkout.razorpay.com/v1/checkout.js';
    script.onload = resolve;
    script.onerror = () => reject(new Error('Could not load Razorpay Checkout. Check your internet connection.'));
    document.head.appendChild(script);
  });
}

async function openRazorpayCheckout(order, checkout) {
  await loadRazorpayScript();
  const razorpay = new window.Razorpay({
    key: checkout.keyId,
    amount: checkout.amount,
    currency: checkout.currency,
    name: 'OrderFlow Demo Store',
    description: `Payment for ${order.id}`,
    order_id: checkout.providerOrderId,
    prefill: { name: state.user?.name || '', email: state.user?.email || '' },
    notes: { applicationOrderId: order.id },
    theme: { color: '#7866e8' },
    handler: async (response) => {
      try {
        const result = await request(API.payments, '/api/payments/razorpay/verify', {
          method: 'POST',
          body: JSON.stringify({ applicationOrderId: order.id, paymentSessionId: checkout.paymentSessionId, ...response }),
        });
        showToast(result.message || 'Payment verified. Kafka is updating the order.');
        await waitForOrderUpdate(order.id);
      } catch (error) {
        showToast(error.message, true);
      }
    },
    modal: { ondismiss: () => showToast('Checkout closed. Order remains pending payment.') },
  });
  razorpay.on('payment.failed', (response) => showToast(response.error?.description || 'Test payment failed. You can try again.', true));
  razorpay.open();
}

async function completeMockPayment(outcome) {
  const session = state.pendingMockPayment;
  if (!session) return;
  el('mock-success-button').disabled = true;
  el('mock-failure-button').disabled = true;
  try {
    const result = await request(API.payments, '/api/payments/mock/complete', {
      method: 'POST',
      body: JSON.stringify({ paymentSessionId: session.paymentSessionId, outcome }),
    });
    el('mock-payment-modal').classList.add('hidden');
    state.pendingMockPayment = null;
    showToast(result.message);
    await waitForOrderUpdate(session.applicationOrderId);
  } catch (error) {
    showToast(error.message, true);
  } finally {
    el('mock-success-button').disabled = false;
    el('mock-failure-button').disabled = false;
  }
}

async function waitForOrderUpdate(orderId) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 700));
    await loadOrders();
    const found = [...document.querySelectorAll('[data-order-id]')].find((node) => node.dataset.orderId === orderId);
    if (found && !found.dataset.status.startsWith('PENDING')) break;
  }
}

async function loadOrders() {
  const body = el('orders-body');
  if (!state.token) {
    body.innerHTML = '<tr><td colspan="5" class="empty-state">Login to see your orders.</td></tr>';
    return;
  }
  try {
    const { orders } = await request(API.orders, '/api/orders');
    if (!orders.length) {
      body.innerHTML = '<tr><td colspan="5" class="empty-state">No orders yet. Choose a product to place your first order.</td></tr>';
      return;
    }
    body.innerHTML = orders.map((order) => {
      const itemSummary = order.items.map((item) => `${escapeHtml(item.name)} × ${item.quantity}`).join(', ');
      const statusClass = order.status === 'PAID' ? 'status-paid' : order.status === 'PENDING_PAYMENT' ? 'status-pending_payment' : order.status === 'PAYMENT_FAILED' ? 'status-payment_failed' : 'status-other';
      return `<tr data-order-id="${escapeHtml(order.id)}" data-status="${escapeHtml(order.status)}"><td><span class="order-id">${escapeHtml(order.id)}</span></td><td>${itemSummary}</td><td><strong>${money(order.totalAmount)}</strong></td><td><span class="order-status ${statusClass}">${escapeHtml(order.status.replaceAll('_', ' '))}</span></td><td>${new Date(order.createdAt).toLocaleString()}</td></tr>`;
    }).join('');
  } catch (error) {
    body.innerHTML = `<tr><td colspan="5" class="empty-state">${escapeHtml(error.message)}</td></tr>`;
  }
}

el('login-form').addEventListener('submit', (event) => authSubmit(event, 'login'));
el('register-form').addEventListener('submit', (event) => authSubmit(event, 'register'));
el('product-form').addEventListener('submit', createProduct);
el('product-grid').addEventListener('click', (event) => {
  const button = event.target.closest('[data-buy]');
  if (button) addToCart(button.dataset.buy);
});
el('refresh-products').addEventListener('click', loadProducts);
el('refresh-orders').addEventListener('click', loadOrders);
el('logout-button').addEventListener('click', () => {
  localStorage.removeItem('orderflow.token');
  localStorage.removeItem('orderflow.user');
  state.token = ''; state.user = null;
  updateAccountUi(); loadOrders(); showToast('Logged out.');
});
el('mock-success-button').addEventListener('click', () => completeMockPayment('success'));
el('mock-failure-button').addEventListener('click', () => completeMockPayment('failure'));
el('close-payment-modal').addEventListener('click', () => el('mock-payment-modal').classList.add('hidden'));
el('mock-payment-modal').addEventListener('click', (event) => {
  if (event.target.dataset.closeModal === 'true') el('mock-payment-modal').classList.add('hidden');
});

updateAccountUi();
loadProducts();
loadOrders();
