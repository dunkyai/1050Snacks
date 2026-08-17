const express = require('express');
const path = require('path');
const Database = require('better-sqlite3');
const { scrapeInstacart } = require('./scraper');
const { placeOrder } = require('./orderer');

const app = express();
const PORT = process.env.PORT || 3000;
const ORDER_THRESHOLD = parseFloat(process.env.ORDER_THRESHOLD || '35');

// Persist cart in a volume-mounted directory so it survives container restarts
const DATA_DIR = process.env.DATA_DIR || '/data';
const db = new Database(path.join(DATA_DIR, 'snacks.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS cart_items (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    store       TEXT    NOT NULL,
    name        TEXT    NOT NULL,
    price       REAL    NOT NULL,
    size        TEXT,
    product_url TEXT,
    added_at    TEXT    DEFAULT (datetime('now')),
    status      TEXT    DEFAULT 'pending'
  );
  CREATE TABLE IF NOT EXISTS orders (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    store       TEXT    NOT NULL,
    total       REAL    NOT NULL,
    item_count  INTEGER NOT NULL,
    placed_at   TEXT    DEFAULT (datetime('now')),
    status      TEXT    DEFAULT 'placing',
    log         TEXT
  );
`);

// Prevent two concurrent checkout runs for the same store
const orderInProgress = new Set();

async function triggerOrder(store) {
  if (orderInProgress.has(store)) return;
  orderInProgress.add(store);

  const items = db.prepare("SELECT * FROM cart_items WHERE store = ? AND status = 'pending'").all(store);
  if (!items.length) { orderInProgress.delete(store); return; }

  // Mark items as 'ordering' immediately so they don't get re-triggered
  const ids = items.map(i => i.id);
  db.prepare(`UPDATE cart_items SET status = 'ordering' WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);

  const orderId = db.prepare('INSERT INTO orders (store, total, item_count) VALUES (?, ?, ?)')
    .run(store, items.reduce((s, i) => s + i.price, 0), items.length).lastInsertRowid;

  const log = [];
  const onProgress = (msg) => {
    console.log(`[order:${store}] ${msg}`);
    log.push(msg);
    db.prepare('UPDATE orders SET log = ? WHERE id = ?').run(JSON.stringify(log), orderId);
  };

  try {
    const result = await placeOrder(store, items, onProgress);
    const finalStatus = result.success ? 'placed' : 'check_screenshots';
    db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(finalStatus, orderId);
    db.prepare(`UPDATE cart_items SET status = 'ordered' WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
  } catch (err) {
    onProgress(`Error: ${err.message}`);
    db.prepare('UPDATE orders SET status = ?, log = ? WHERE id = ?').run('failed', JSON.stringify(log), orderId);
    // Put items back to pending so they can be retried
    db.prepare(`UPDATE cart_items SET status = 'pending' WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
  } finally {
    orderInProgress.delete(store);
  }
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Search (SSE) ---
app.get('/search', async (req, res) => {
  const query = (req.query.q || '').trim();
  if (!query) { res.status(400).json({ error: 'Missing ?q=' }); return; }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  try {
    await scrapeInstacart(query, (result) => send({ type: 'store', ...result }));
    send({ type: 'done' });
  } catch (err) {
    send({ type: 'error', message: err.message });
  }
  res.end();
});

// --- Cart ---
app.get('/cart', (req, res) => {
  const items = db.prepare("SELECT * FROM cart_items WHERE status IN ('pending','ordering') ORDER BY added_at").all();
  const byStore = {};
  for (const item of items) {
    if (!byStore[item.store]) byStore[item.store] = { items: [], total: 0 };
    byStore[item.store].items.push(item);
    byStore[item.store].total = +(byStore[item.store].total + item.price).toFixed(2);
  }

  // Attach latest order status per store
  const latestOrders = db.prepare(`
    SELECT store, status, log, placed_at FROM orders
    WHERE id IN (SELECT MAX(id) FROM orders GROUP BY store)
  `).all();
  const orderByStore = Object.fromEntries(latestOrders.map(o => [o.store, o]));

  res.json({ stores: byStore, threshold: ORDER_THRESHOLD, orders: orderByStore });
});

app.post('/cart/add', (req, res) => {
  const { store, name, price, size, productUrl } = req.body;
  if (!store || !name || price == null) {
    return res.status(400).json({ error: 'store, name, price required' });
  }

  db.prepare('INSERT INTO cart_items (store, name, price, size, product_url) VALUES (?, ?, ?, ?, ?)')
    .run(store, name, price, size || null, productUrl || null);

  const { total } = db.prepare("SELECT SUM(price) as total FROM cart_items WHERE store = ? AND status = 'pending'").get(store);
  const rounded = +(total || 0).toFixed(2);

  if (rounded >= ORDER_THRESHOLD && !orderInProgress.has(store)) {
    triggerOrder(store).catch(err => console.error('triggerOrder failed:', err.message));
  }

  res.json({ total: rounded, threshold: ORDER_THRESHOLD, ordering: orderInProgress.has(store) });
});

app.delete('/cart/item/:id', (req, res) => {
  db.prepare("DELETE FROM cart_items WHERE id = ? AND status = 'pending'").run(req.params.id);
  res.json({ ok: true });
});

// Manual order trigger (for when you want to order below the threshold)
app.post('/cart/order/:store', async (req, res) => {
  const { store } = req.params;
  if (orderInProgress.has(store)) return res.json({ ok: false, message: 'Order already in progress' });
  triggerOrder(store).catch(err => console.error('manual triggerOrder failed:', err.message));
  res.json({ ok: true, message: `Order started for ${store}` });
});

app.listen(PORT, () => console.log(`1050Snacks running on port ${PORT}`));
