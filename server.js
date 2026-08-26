const express = require('express');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { scrapeInstacart, rankProducts } = require('./scraper');
const { placeOrder } = require('./orderer');
const SWITCHBOT_ITEMS = require('./switchbot-items');

const app = express();
const PORT = process.env.PORT || 3000;
const ORDER_THRESHOLD = parseFloat(process.env.ORDER_THRESHOLD || '35');
const SNACKS_CHANNEL = process.env.SNACKS_CHANNEL || 'C0B733ABPQX';

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
    status      TEXT    DEFAULT 'pending',
    slack_channel TEXT
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

// Migrate existing DB if slack_channel column is missing
try { db.exec('ALTER TABLE cart_items ADD COLUMN slack_channel TEXT'); } catch {}

// On startup, reset any orders/items left mid-flight by a previous crash or redeploy
db.exec(`
  UPDATE orders    SET status = 'failed'  WHERE status = 'placing';
  UPDATE cart_items SET status = 'pending' WHERE status = 'ordering';
`);

const orderInProgress = new Set();

const ORDER_APPROVERS = new Set([
  'U0B7LBRFBS5', // Elizabeth
  'U0B7KUWANKU', // Nicole
  'U0BL9CFA7PY', // Dawn
  'U0B7JH0GN2W', // Eric
  'U0B7DAQ5L91', // Shiyan
]);

// ── Slack ─────────────────────────────────────────────────────────────────────
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
const SWITCHBOT_WEBHOOK_TOKEN = process.env.SWITCHBOT_WEBHOOK_TOKEN;

function verifySlack(req, res, next) {
  if (!SLACK_SIGNING_SECRET) return next(); // skip in dev
  const ts = req.headers['x-slack-request-timestamp'];
  const sig = req.headers['x-slack-signature'];
  if (!ts || !sig) return res.sendStatus(403);
  if (Math.abs(Date.now() / 1000 - ts) > 300) return res.sendStatus(403);
  const hmac = crypto.createHmac('sha256', SLACK_SIGNING_SECRET)
    .update(`v0:${ts}:${req.rawBody}`)
    .digest('hex');
  if (`v0=${hmac}` !== sig) return res.sendStatus(403);
  next();
}

function captureRawBody(req, res, buf) { req.rawBody = buf.toString(); }

async function slackPost(url, body) {
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function slackApi(method, body) {
  if (!SLACK_BOT_TOKEN) return;
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) console.error(`[slack] ${method} failed:`, data.error, JSON.stringify(body).slice(0, 200));
  return data;
}

function cartConfirmBlocks(store, total, items) {
  return {
    text: `🛒 ${store} cart is at $${total.toFixed(2)} — ready to order?`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `🛒 *${store} cart — $${total.toFixed(2)}* (${items.length} item${items.length !== 1 ? 's' : ''})\n${items.map(i => `• ${i.name} — $${i.price.toFixed(2)}`).join('\n')}\n\nReady to order?`,
        },
      },
      {
        type: 'actions',
        elements: [
          { type: 'button', text: { type: 'plain_text', text: 'Buy & send now (can\'t be undone)' }, style: 'primary', action_id: 'confirm_order', value: store },
          { type: 'button', text: { type: 'plain_text', text: '➕  Keep adding' }, action_id: 'skip_order', value: store },
        ],
      },
    ],
  };
}

function cartBlocks(byStore, threshold) {
  const blocks = [];
  const stores = Object.entries(byStore);

  if (!stores.length) {
    return [{ type: 'section', text: { type: 'mrkdwn', text: 'Cart is empty — use `/snacks [query]` to search.' } }];
  }

  for (const [store, info] of stores) {
    const ready = info.total >= threshold;
    const filled = Math.round((info.total / threshold) * 10);
    const bar = '█'.repeat(Math.min(filled, 10)) + '░'.repeat(Math.max(0, 10 - filled));

    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*${store} Cart — $${info.total.toFixed(2)} / $${threshold}*\n${bar}  ${ready ? '✅ Ready to order!' : `$${(threshold - info.total).toFixed(2)} to go`}` },
    });

    for (const item of info.items) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `• ${item.name} — $${item.price.toFixed(2)}` },
        accessory: {
          type: 'button',
          text: { type: 'plain_text', text: 'Remove' },
          style: 'danger',
          action_id: 'remove_item',
          value: String(item.id),
        },
      });
    }

    blocks.push({
      type: 'actions',
      elements: ready
        ? [
            { type: 'button', text: { type: 'plain_text', text: 'Buy & send now (can\'t be undone)' }, style: 'primary', action_id: 'confirm_order', value: store },
            { type: 'button', text: { type: 'plain_text', text: '➕  Keep adding' }, action_id: 'skip_order', value: store },
          ]
        : [
            { type: 'button', text: { type: 'plain_text', text: 'Buy & send now (can\'t be undone)' }, style: 'primary', action_id: 'checkout', value: store },
          ],
    });

    blocks.push({ type: 'divider' });
  }

  return blocks;
}

function getCartByStore() {
  const items = db.prepare("SELECT * FROM cart_items WHERE status IN ('pending','ordering') ORDER BY added_at").all();
  const byStore = {};
  for (const item of items) {
    if (!byStore[item.store]) byStore[item.store] = { items: [], total: 0 };
    byStore[item.store].items.push(item);
    byStore[item.store].total = +(byStore[item.store].total + item.price).toFixed(2);
  }
  return byStore;
}

function searchBlocks(store, products) {
  const blocks = [{ type: 'header', text: { type: 'plain_text', text: `${store} results` } }];
  for (const p of products.slice(0, 8)) {
    const ppm = p.pricePerMeal != null ? ` · *$${p.pricePerMeal.toFixed(2)}/snack*` : '';
    const size = p.size ? ` · ${p.size}` : '';
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*${p.name}*\n$${p.price.toFixed(2)}${size}${ppm}` },
      accessory: {
        type: 'button',
        text: { type: 'plain_text', text: 'Add to Cart' },
        action_id: 'add_to_cart',
        value: JSON.stringify({ store, name: p.name, price: p.price, size: p.size || '' }).slice(0, 2000),
      },
    });
  }
  if (!products.length) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `No results found at ${store}.` } });
  }
  return blocks;
}

// ── Order runner ──────────────────────────────────────────────────────────────
async function triggerOrder(store) {
  if (orderInProgress.has(store)) return;
  orderInProgress.add(store);

  const items = db.prepare("SELECT * FROM cart_items WHERE store = ? AND status = 'pending'").all(store);
  if (!items.length) { orderInProgress.delete(store); return; }

  const slackChannel = items.find(i => i.slack_channel)?.slack_channel;

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
    if (slackChannel) {
      const icon = result.success ? '✅' : '⚠️';
      const receiptPart = result.driveLink ? ` | <${result.driveLink}|Receipt>` : '';
      await slackApi('chat.postMessage', { channel: slackChannel, text: `${icon} ${store} order ${finalStatus}.${receiptPart} ${result.url || ''}` });
    }
    if (result.failedItems?.length) {
      await slackApi('chat.postMessage', {
        channel: SNACKS_CHANNEL,
        text: `⚠️ ${result.failedItems.length} item(s) couldn't be found on Instacart and were skipped:\n${result.failedItems.map(n => `• ${n}`).join('\n')}\nSearch manually with \`/snacks\` to add a substitute.`,
      });
    }
  } catch (err) {
    onProgress(`Error: ${err.message}`);
    db.prepare('UPDATE orders SET status = ?, log = ? WHERE id = ?').run('failed', JSON.stringify(log), orderId);
    db.prepare(`UPDATE cart_items SET status = 'pending' WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
    if (slackChannel) {
      await slackApi('chat.postMessage', { channel: slackChannel, text: `❌ ${store} order failed — check docker logs for details.` });
    }
  } finally {
    orderInProgress.delete(store);
  }
}

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-store');
  },
}));

// ── Search (SSE) ──────────────────────────────────────────────────────────────
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
    const storeResults = [];
    await scrapeInstacart(query, (result) => storeResults.push(result));
    for (const result of storeResults) {
      send({ type: 'store', store: result.store, products: result.products });
    }
    send({ type: 'done' });
  } catch (err) {
    send({ type: 'error', message: err.message });
  }
  res.end();
});

// ── Cart (web UI) ─────────────────────────────────────────────────────────────
app.get('/cart', (req, res) => {
  const items = db.prepare("SELECT * FROM cart_items WHERE status IN ('pending','ordering') ORDER BY added_at").all();
  const byStore = {};
  for (const item of items) {
    if (!byStore[item.store]) byStore[item.store] = { items: [], total: 0 };
    byStore[item.store].items.push(item);
    byStore[item.store].total = +(byStore[item.store].total + item.price).toFixed(2);
  }
  const latestOrders = db.prepare(`
    SELECT store, status, log, placed_at FROM orders
    WHERE id IN (SELECT MAX(id) FROM orders GROUP BY store)
  `).all();
  const orderByStore = Object.fromEntries(latestOrders.map(o => [o.store, o]));
  res.json({ stores: byStore, threshold: ORDER_THRESHOLD, orders: orderByStore });
});

app.post('/cart/add', (req, res) => {
  const { store, name, price, size, productUrl } = req.body;
  if (!store || !name || price == null) return res.status(400).json({ error: 'store, name, price required' });

  db.prepare('INSERT INTO cart_items (store, name, price, size, product_url) VALUES (?, ?, ?, ?, ?)')
    .run(store, name, price, size || null, productUrl || null);

  const { total } = db.prepare("SELECT SUM(price) as total FROM cart_items WHERE store = ? AND status = 'pending'").get(store);
  const rounded = +(total || 0).toFixed(2);

  res.json({ total: rounded, threshold: ORDER_THRESHOLD, ordering: orderInProgress.has(store) });
});

app.delete('/cart/item/:id', (req, res) => {
  db.prepare("DELETE FROM cart_items WHERE id = ? AND status = 'pending'").run(req.params.id);
  res.json({ ok: true });
});

app.post('/cart/order/:store', async (req, res) => {
  const { store } = req.params;
  if (orderInProgress.has(store)) return res.json({ ok: false, message: 'Order already in progress' });
  triggerOrder(store).catch(err => console.error('manual triggerOrder failed:', err.message));
  res.json({ ok: true, message: `Order started for ${store}` });
});

// ── Slack slash command: /cart ────────────────────────────────────────────────
app.post('/slack/cart',
  express.urlencoded({ extended: true, verify: captureRawBody }),
  verifySlack,
  (req, res) => {
    const byStore = getCartByStore();
    res.json({
      response_type: 'ephemeral',
      text: 'Your cart:',
      blocks: cartBlocks(byStore, ORDER_THRESHOLD),
    });
  }
);

// ── Slack slash command: /snacks [query] ──────────────────────────────────────
app.post('/slack/search',
  express.urlencoded({ extended: true, verify: captureRawBody }),
  verifySlack,
  async (req, res) => {
    const { text, response_url, channel_id } = req.body;
    const query = (text || '').trim();
    if (!query) {
      return res.json({ response_type: 'ephemeral', text: 'Usage: `/snacks chips` — enter a snack to search for.' });
    }

    const surprise = /\bsurprise\b/i.test(query);
    const searchQuery = query.replace(/\bsurprise\b/i, '').trim();

    // Ack immediately — Slack requires a response within 3s
    res.json({
      response_type: 'in_channel',
      text: surprise
        ? `🎲 Finding the best *${searchQuery}* for you…`
        : `Searching Costco for *${searchQuery}*…`,
    });

    try {
      const storeResults = [];
      await scrapeInstacart(searchQuery, (result) => storeResults.push(result));

      if (surprise) {
        // Pick the #1 ranked item and add it to the cart automatically
        const products = storeResults[0]?.products || [];
        const ranked = await rankProducts(products);
        const pick = ranked[0];

        if (!pick) {
          await slackPost(response_url, { response_type: 'in_channel', replace_original: true, text: `Couldn't find anything for "${searchQuery}" 😔` });
          return;
        }

        db.prepare('INSERT INTO cart_items (store, name, price, size, product_url, slack_channel) VALUES (?, ?, ?, ?, ?, ?)')
          .run('Costco', pick.name, pick.price, pick.size || null, pick.productUrl || null, channel_id);

        const { total } = db.prepare("SELECT SUM(price) as total FROM cart_items WHERE store = 'Costco' AND status = 'pending'").get();
        const rounded = +(total || 0).toFixed(2);
        const pendingItems = db.prepare("SELECT * FROM cart_items WHERE store = 'Costco' AND status = 'pending'").all();

        await slackPost(response_url, {
          response_type: 'in_channel',
          replace_original: true,
          text: `🎲 Added *${pick.name}* — $${pick.price.toFixed(2)}${pick.size ? ` · ${pick.size}` : ''}\nCart total: $${rounded.toFixed(2)} / $${ORDER_THRESHOLD}${rounded >= ORDER_THRESHOLD ? ' ✅' : ''}`,
        });
        return;
      }

      const allBlocks = [];
      for (const { store, products } of storeResults) {
        allBlocks.push(...searchBlocks(store, products));
        allBlocks.push({ type: 'divider' });
      }

      await slackPost(response_url, {
        response_type: 'in_channel',
        replace_original: true,
        blocks: allBlocks.slice(0, 50),
        text: `Costco results for "${searchQuery}"`,
      });
    } catch (err) {
      await slackPost(response_url, { response_type: 'in_channel', replace_original: true, text: `Error searching: ${err.message}` });
    }
  }
);

// ── Slack interactions (button clicks) ───────────────────────────────────────
app.post('/slack/interact',
  express.urlencoded({ extended: true, verify: captureRawBody }),
  verifySlack,
  async (req, res) => {
    let payload;
    try { payload = JSON.parse(req.body.payload); } catch { return res.sendStatus(400); }

    const action = payload.actions?.[0];
    if (!action) return res.sendStatus(400);

    const channelId = payload.channel?.id;
    const userId = payload.user?.id;
    const responseUrl = payload.response_url;

    res.sendStatus(200); // Ack immediately
    console.log(`[interact] action=${action.action_id} user=${userId} channel=${channelId}`);

    if (action.action_id === 'add_to_cart') {
      let item;
      try { item = JSON.parse(action.value); } catch (e) {
        console.error('[interact] bad add_to_cart value:', action.value, e.message);
        return;
      }

      db.prepare('INSERT INTO cart_items (store, name, price, size, slack_channel) VALUES (?, ?, ?, ?, ?)')
        .run(item.store, item.name, item.price, item.size || null, channelId);

      const { total } = db.prepare("SELECT SUM(price) as total FROM cart_items WHERE store = ? AND status = 'pending'").get(item.store);
      const rounded = +(total || 0).toFixed(2);
      const pendingItems = db.prepare("SELECT * FROM cart_items WHERE store = ? AND status = 'pending'").all(item.store);

      if (rounded >= ORDER_THRESHOLD && !orderInProgress.has(item.store)) {
        const notifyChannel = SNACKS_CHANNEL || channelId || pendingItems.find(i => i.slack_channel)?.slack_channel;
        console.log(`[interact] threshold reached $${rounded} in ${item.store}, notifying channel=${notifyChannel}`);
        if (notifyChannel) {
          await slackApi('chat.postMessage', {
            channel: notifyChannel,
            ...cartConfirmBlocks(item.store, rounded, pendingItems),
          });
        }
      } else {
        // Use postEphemeral so the original search results message stays intact
        if (channelId && userId) {
          await slackApi('chat.postEphemeral', {
            channel: channelId,
            user: userId,
            text: `✓ Added *${item.name}* — cart total $${rounded.toFixed(2)} / $${ORDER_THRESHOLD}`,
          });
        } else if (responseUrl) {
          await slackPost(responseUrl, {
            response_type: 'ephemeral',
            text: `✓ Added *${item.name}* — cart total $${rounded.toFixed(2)} / $${ORDER_THRESHOLD}`,
          });
        }
      }
    }

    if (action.action_id === 'remove_item') {
      db.prepare("DELETE FROM cart_items WHERE id = ? AND status = 'pending'").run(parseInt(action.value));
      const byStore = getCartByStore();
      await slackPost(responseUrl, {
        response_type: 'ephemeral',
        replace_original: true,
        text: 'Your cart:',
        blocks: cartBlocks(byStore, ORDER_THRESHOLD),
      });
      return;
    }

    if (action.action_id === 'checkout') {
      const store = action.value;
      const { total } = db.prepare("SELECT SUM(price) as total FROM cart_items WHERE store = ? AND status = 'pending'").get(store);
      const rounded = +(total || 0).toFixed(2);
      const pendingItems = db.prepare("SELECT * FROM cart_items WHERE store = ? AND status = 'pending'").all(store);
      await slackPost(responseUrl, {
        response_type: 'ephemeral',
        replace_original: true,
        ...cartConfirmBlocks(store, rounded, pendingItems),
      });
      return;
    }

    if (action.action_id === 'confirm_order') {
      const store = action.value;
      if (!ORDER_APPROVERS.has(payload.user?.id)) {
        await slackPost(responseUrl, { response_type: 'ephemeral', text: `Sorry, only authorized members can place orders.` });
        return;
      }
      if (orderInProgress.has(store)) return;

      await slackPost(responseUrl, {
        response_type: 'in_channel',
        replace_original: true,
        text: `⏳ Placing ${store} order…`,
      });

      triggerOrder(store).catch(async (err) => {
        await slackApi('chat.postMessage', { channel: channelId, text: `❌ Order failed — check docker logs for details.` });
      });
    }

    if (action.action_id === 'skip_order') {
      await slackPost(responseUrl, {
        response_type: 'in_channel',
        replace_original: true,
        text: `➕ Got it — I'll check in again after the next item is added.`,
      });
    }
  }
);

// ── SwitchBot webhook ─────────────────────────────────────────────────────────
// Register this URL in the SwitchBot app: Profile → Preferences → Webhooks.
// URL format: https://<host>/webhook/switchbot?token=SWITCHBOT_WEBHOOK_TOKEN
app.post('/webhook/switchbot', async (req, res) => {
  if (SWITCHBOT_WEBHOOK_TOKEN && req.query.token !== SWITCHBOT_WEBHOOK_TOKEN) {
    return res.sendStatus(403);
  }

  const { eventType, context } = req.body || {};
  if (eventType !== 'changeReport' || context?.power !== 'on') {
    return res.sendStatus(200); // ignore release events and other event types
  }

  // Normalize device identifier — webhook payloads use MAC with dashes (B0-E9-FE-E6-6C-BA),
  // but our config keys use the raw deviceId from the API (B0E9FEE66CBA).
  const deviceId = (context.deviceMacAddress || context.deviceId || '')
    .toUpperCase().replace(/[^A-F0-9]/g, '');
  const itemConfig = SWITCHBOT_ITEMS[deviceId];

  if (!itemConfig) {
    console.log(`[switchbot] unknown device: ${deviceId}`);
    await slackApi('chat.postMessage', {
      channel: SNACKS_CHANNEL,
      text: `⚠️ SwitchBot button pressed but device \`${deviceId}\` isn't configured in \`switchbot-items.js\`.`,
    });
    return res.sendStatus(200);
  }

  console.log(`[switchbot] ${itemConfig.emoji} ${itemConfig.label} button pressed (${deviceId})`);

  const row = db.prepare(
    'INSERT INTO cart_items (store, name, price, size, slack_channel) VALUES (?, ?, ?, ?, ?)'
  ).run(itemConfig.store, itemConfig.name, itemConfig.price, itemConfig.size || null, SNACKS_CHANNEL);

  const itemId = row.lastInsertRowid;
  const { total } = db.prepare(
    "SELECT SUM(price) as total FROM cart_items WHERE store = ? AND status = 'pending'"
  ).get(itemConfig.store);
  const rounded = +(total || 0).toFixed(2);
  const pendingItems = db.prepare(
    "SELECT * FROM cart_items WHERE store = ? AND status = 'pending'"
  ).all(itemConfig.store);

  const barFilled = Math.round((rounded / ORDER_THRESHOLD) * 10);
  const bar = '█'.repeat(Math.min(barFilled, 10)) + '░'.repeat(Math.max(0, 10 - barFilled));
  const toGo = rounded >= ORDER_THRESHOLD
    ? '✅ Ready to order!'
    : `$${(ORDER_THRESHOLD - rounded).toFixed(2)} to go`;

  await slackApi('chat.postMessage', {
    channel: SNACKS_CHANNEL,
    text: `${itemConfig.emoji} ${itemConfig.label} button pressed — added to ${itemConfig.store} cart`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: itemConfig.crisisMessage || `${itemConfig.emoji} *${itemConfig.label} button pressed*`,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `Added to ${itemConfig.store} cart: *${itemConfig.name}*${itemConfig.size ? ` · ${itemConfig.size}` : ''} — $${itemConfig.price.toFixed(2)}\n${bar}  $${rounded.toFixed(2)} / $${ORDER_THRESHOLD}  ${toGo}`,
        },
        accessory: {
          type: 'button',
          text: { type: 'plain_text', text: '✕ Remove' },
          style: 'danger',
          action_id: 'remove_item',
          value: String(itemId),
        },
      },
    ],
  });

  if (rounded >= ORDER_THRESHOLD && !orderInProgress.has(itemConfig.store)) {
    await slackApi('chat.postMessage', {
      channel: SNACKS_CHANNEL,
      ...cartConfirmBlocks(itemConfig.store, rounded, pendingItems),
    });
  }

  res.sendStatus(200);
});

app.listen(PORT, () => console.log(`1050Snacks running on port ${PORT}`));
