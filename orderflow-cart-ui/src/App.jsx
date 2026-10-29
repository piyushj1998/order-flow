import { useEffect, useMemo, useState } from 'react';
import './App.css';

const CATALOG_API = 'http://localhost:3002/api/products';
const CART_STORAGE_KEY = 'orderflow.react.cart.v1';

const formatMoney = (value) =>
  new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 2,
  }).format(Number(value) || 0);

function readSavedCart() {
  try {
    const saved = JSON.parse(localStorage.getItem(CART_STORAGE_KEY) || '[]');
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
}

export default function App() {
  const [products, setProducts] = useState([]);
  const [cart, setCart] = useState(readSavedCart);
  const [activePage, setActivePage] = useState('shop');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    let cancelled = false;

    async function loadCatalog() {
      setLoading(true);
      setLoadError('');
      try {
        const response = await fetch(CATALOG_API);
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(body.error || `Catalog request failed (${response.status}).`);
        }
        if (!cancelled) {
          setProducts(Array.isArray(body.products) ? body.products : []);
        }
      } catch (error) {
        if (!cancelled) {
          setLoadError(
            `${error.message} Make sure Order Service is running on port 3003 and the Kafka consumer has synced at least one product.`
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadCatalog();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(cart));
  }, [cart]);

  useEffect(() => {
    if (!notice) return undefined;
    const timer = window.setTimeout(() => setNotice(''), 2800);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const cartCount = useMemo(
    () => cart.reduce((sum, item) => sum + item.quantity, 0),
    [cart]
  );

  const cartTotal = useMemo(
    () => cart.reduce((sum, item) => sum + Number(item.price) * item.quantity, 0),
    [cart]
  );

  function addToCart(product) {
    const stock = Number(product.stock) || 0;
    const maxQuantity = Math.min(stock, 20);
    if (maxQuantity < 1) {
      setNotice('This product is currently out of stock.');
      return;
    }

    const existing = cart.find((item) => item.productId === product.id);
    if (existing && existing.quantity >= maxQuantity) {
      setNotice(`Only ${maxQuantity} item(s) can be added based on available stock.`);
      return;
    }

    setCart((current) => {
      const found = current.find((item) => item.productId === product.id);
      if (found) {
        return current.map((item) =>
          item.productId === product.id
            ? { ...item, quantity: Math.min(item.quantity + 1, maxQuantity) }
            : item
        );
      }
      return [
        ...current,
        {
          productId: product.id,
          name: product.name,
          description: product.description || '',
          price: Number(product.price) || 0,
          stock,
          emoji: product.emoji || '📦',
          quantity: 1,
        },
      ];
    });
    setNotice(`${product.name} added to your cart.`);
  }

  function changeQuantity(productId, delta) {
    setCart((current) =>
      current
        .map((item) => {
          if (item.productId !== productId) return item;
          const maxQuantity = Math.min(Number(item.stock) || 0, 20);
          return {
            ...item,
            quantity: Math.max(0, Math.min(item.quantity + delta, maxQuantity)),
          };
        })
        .filter((item) => item.quantity > 0)
    );
  }

  function removeFromCart(productId) {
    setCart((current) => current.filter((item) => item.productId !== productId));
    setNotice('Item removed from cart.');
  }

  function clearCart() {
    setCart([]);
    setNotice('Cart cleared.');
  }

  function continueToCheckout() {
    if (!cart.length) {
      setNotice('Your cart is empty. Add a product first.');
      return;
    }
    setNotice('Cart is ready. Next we will connect checkout to the Order and Payment APIs.');
  }

  const productsInCart = new Map(cart.map((item) => [item.productId, item.quantity]));

  return (
    <div className="app-shell">
      <header className="topbar">
        <button className="brand" onClick={() => setActivePage('shop')} aria-label="OrderFlow home">
          <span className="brand-mark">O</span>
          <span>Order<span className="brand-light">Flow</span></span>
        </button>

        <nav className="main-nav" aria-label="Main navigation">
          <button
            className={`nav-link ${activePage === 'shop' ? 'active' : ''}`}
            onClick={() => setActivePage('shop')}
          >
            Shop
          </button>
          <button
            className={`nav-link cart-nav ${activePage === 'cart' ? 'active' : ''}`}
            onClick={() => setActivePage('cart')}
          >
            <span aria-hidden="true">🛒</span> Cart
            <span className="cart-count">{cartCount}</span>
          </button>
        </nav>
      </header>

      <main className="page-wrap">
        <section className="hero">
          <div className="hero-copy">
            <span className="eyebrow"><span className="eyebrow-dot" /> YOUR EVERYDAY STORE</span>
            <h1>{activePage === 'cart' ? 'Your cart, your picks.' : 'Everyday essentials.'}</h1>
            <p>
              {activePage === 'cart'
                ? 'Review your items, change quantities, and check your total before checkout.'
                : 'Useful things. Simple shopping. Add your favourites to the cart and keep everything in one place.'}
            </p>
            {activePage === 'shop' && (
              <button className="button button-light" onClick={() => document.getElementById('catalog')?.scrollIntoView({ behavior: 'smooth' })}>
                Explore products <span aria-hidden="true">↓</span>
              </button>
            )}
          </div>
          <div className="hero-art" aria-hidden="true">
            <div className="hero-orbit orbit-one" />
            <div className="hero-orbit orbit-two" />
            <div className="hero-bag">🛍️</div>
            <span className="floating-emoji float-one">📦</span>
            <span className="floating-emoji float-two">✨</span>
            <span className="floating-emoji float-three">🎧</span>
          </div>
        </section>

        <div className="section-bar" id="catalog">
          <div>
            <p className="section-kicker">ORDERFLOW CATALOG</p>
            <h2>{activePage === 'cart' ? 'Shopping cart' : 'Find your essentials'}</h2>
          </div>
          {activePage === 'shop' ? (
            <div className="catalog-actions">
              <span className="product-count">{loading ? 'Loading…' : `${products.length} products`}</span>
              <button className="button button-outline" onClick={() => window.location.reload()}>↻ Refresh</button>
            </div>
          ) : (
            <button className="button button-outline" onClick={() => setActivePage('shop')}>← Continue shopping</button>
          )}
        </div>

        {activePage === 'shop' && (
          <>
            {loading && <div className="state-card"><span className="spinner" /> Loading products from the order catalog…</div>}
            {!loading && loadError && (
              <div className="state-card state-error">
                <strong>Could not load products</strong>
                <p>{loadError}</p>
                <button className="button button-outline" onClick={() => window.location.reload()}>Try again</button>
              </div>
            )}
            {!loading && !loadError && products.length === 0 && (
              <div className="state-card">
                <div className="empty-icon">📦</div>
                <strong>No products in the order catalog yet</strong>
                <p>Create a product, then make sure your Kafka consumer saves its event to <code>order_product_catalog</code>.</p>
              </div>
            )}
            {!loading && !loadError && products.length > 0 && (
              <div className="product-grid">
                {products.map((product) => {
                  const inCart = productsInCart.get(product.id) || 0;
                  const stock = Number(product.stock) || 0;
                  return (
                    <article className="product-card" key={product.id}>
                      <div className="product-visual">
                        <span className={`stock-pill ${stock < 1 ? 'out' : ''}`}>
                          {stock < 1 ? 'Out of stock' : `${stock} in stock`}
                        </span>
                        <span className="product-emoji" role="img" aria-label={product.name}>{product.emoji || '📦'}</span>
                      </div>
                      <div className="product-details">
                        <span className="product-id">ID · {product.id}</span>
                        <h3>{product.name}</h3>
                        <p className="product-description">{product.description || 'An everyday essential, ready for your cart.'}</p>
                        <div className="product-card-bottom">
                          <div className="price">{formatMoney(product.price)}<small>INR · per item</small></div>
                          <button
                            className={`button ${inCart ? 'button-added' : 'button-primary'}`}
                            disabled={stock < 1 || inCart >= Math.min(stock, 20)}
                            onClick={() => addToCart(product)}
                          >
                            {stock < 1 ? 'Unavailable' : inCart ? `In cart · ${inCart}` : 'Add to cart +'}
                          </button>
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </>
        )}

        {activePage === 'cart' && (
          <div className="cart-layout">
            <section className="cart-items-panel">
              {cart.length === 0 ? (
                <div className="state-card cart-empty">
                  <div className="empty-icon">🛒</div>
                  <strong>Your cart is empty</strong>
                  <p>Browse the catalog and add something you like.</p>
                  <button className="button button-primary" onClick={() => setActivePage('shop')}>Browse products</button>
                </div>
              ) : (
                <>
                  <div className="cart-panel-heading">
                    <span>{cartCount} item{cartCount === 1 ? '' : 's'} in your cart</span>
                    <button className="text-button danger-text" onClick={clearCart}>Clear cart</button>
                  </div>
                  {cart.map((item) => {
                    const maxQuantity = Math.min(Number(item.stock) || 0, 20);
                    return (
                      <article className="cart-item" key={item.productId}>
                        <div className="cart-item-visual">{item.emoji || '📦'}</div>
                        <div className="cart-item-info">
                          <span className="product-id">ID · {item.productId}</span>
                          <h3>{item.name}</h3>
                          <p>{formatMoney(item.price)} <span>per item</span></p>
                          <button className="text-button danger-text remove-button" onClick={() => removeFromCart(item.productId)}>Remove</button>
                        </div>
                        <div className="cart-item-actions">
                          <div className="quantity-control" aria-label={`Quantity for ${item.name}`}>
                            <button onClick={() => changeQuantity(item.productId, -1)} aria-label="Decrease quantity">−</button>
                            <span>{item.quantity}</span>
                            <button onClick={() => changeQuantity(item.productId, 1)} disabled={item.quantity >= maxQuantity} aria-label="Increase quantity">+</button>
                          </div>
                          <strong className="line-total">{formatMoney(item.price * item.quantity)}</strong>
                        </div>
                      </article>
                    );
                  })}
                </>
              )}
            </section>

            {cart.length > 0 && (
              <aside className="summary-card">
                <p className="section-kicker">ORDER SUMMARY</p>
                <h2>Cart totals</h2>
                <div className="summary-row"><span>Items</span><span>{cartCount}</span></div>
                <div className="summary-row"><span>Subtotal</span><span>{formatMoney(cartTotal)}</span></div>
                <div className="summary-row"><span>Shipping</span><span className="free-label">Free</span></div>
                <div className="summary-total"><span>Total</span><strong>{formatMoney(cartTotal)}</strong></div>
                <button className="button button-primary checkout-button" onClick={continueToCheckout}>Continue to checkout <span>→</span></button>
                <p className="summary-note">Taxes and final stock checks are handled during checkout.</p>
              </aside>
            )}
          </div>
        )}

        <footer className="footer-note">
          <span>OrderFlow</span><span>Microservices learning project · Kafka-powered catalog</span>
        </footer>
      </main>

      {notice && <div className="toast" role="status">{notice}</div>}
    </div>
  );
}
