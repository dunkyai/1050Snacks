const { chromium } = require('playwright');
const { saveReceipt } = require('./receipts');
const { groupCartItems, reconcileCart, isCartClean, describeMismatch } = require('./cart-utils');

const STORE_SLUGS = { Costco: 'costco', Safeway: 'safeway' }; // slug from /store/<slug>/storefront

async function injectSessionCookies(context) {
  const b64 = process.env.INSTACART_COOKIES_B64;
  const raw = b64 ? Buffer.from(b64, 'base64').toString('utf8') : process.env.INSTACART_COOKIES;
  if (!raw) throw new Error('No session cookies configured');
  const exported = JSON.parse(raw);
  const sameSiteMap = { strict: 'Strict', lax: 'Lax', no_restriction: 'None', none: 'None' };
  const cookies = exported.map(c => ({
    name: c.name, value: c.value,
    domain: c.hostOnly ? c.domain.replace(/^\./, '') : (c.domain.startsWith('.') ? c.domain : `.${c.domain}`),
    path: c.path || '/',
    expires: c.expirationDate ? Math.floor(c.expirationDate) : -1,
    httpOnly: c.httpOnly ?? false,
    secure: c.secure ?? false,
    sameSite: sameSiteMap[(c.sameSite || '').toLowerCase()] ?? 'Lax',
  })).filter(c => c.name && c.value);
  await context.addCookies(cookies);
}

function extractOrderNumber(url) {
  // /store/orders/<id> or /orders/<id> or ?order_id=
  const m = url.match(/\/store\/orders\/([A-Za-z0-9_-]+)/) ||
            url.match(/\/orders?\/([A-Za-z0-9_-]+)/) ||
            url.match(/[?&]order[_-]?(?:id|num(?:ber)?)=([A-Za-z0-9_-]+)/i);
  return m ? m[1] : null;
}

async function dismissPopups(page) {
  // Press Escape to close any open dialog
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(500);

  // Click any visible close/dismiss buttons inside dialogs or modals
  const closeSelectors = [
    '[role="dialog"] button[aria-label*="close" i]',
    '[role="dialog"] button[aria-label*="dismiss" i]',
    '[role="dialog"] button:has-text("×")',
    '[role="dialog"] button:has-text("✕")',
    'button[data-testid*="close"]',
    'button[aria-label*="close" i]',
  ];
  for (const sel of closeSelectors) {
    const btn = page.locator(sel).first();
    const visible = await btn.isVisible().catch(() => false);
    if (visible) {
      await btn.click({ force: true }).catch(() => {});
      await page.waitForTimeout(400);
    }
  }

  // Click outside any remaining overlay to dismiss it
  await page.evaluate(() => {
    const overlay = document.querySelector('[role="dialog"], [data-dialog-ref], [class*="modal" i], [class*="overlay" i]');
    if (overlay) overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }).catch(() => {});
  await page.waitForTimeout(500);
}

async function saveOrderPdf(page, url, ts) {
  const imgPath = `/tmp/order-${ts}-placed.png`;
  // Navigate to the order detail page for a clean screenshot
  const orderId = extractOrderNumber(url);
  if (orderId) {
    const orderDetailUrl = `https://www.instacart.com/store/orders/${orderId}`;
    await page.goto(orderDetailUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(3000);
  }
  await dismissPopups(page);
  // Expand collapsed sections (Your items, Receipt)
  for (const label of ['Your items', 'Receipt']) {
    const btn = page.locator(`button:has-text("${label}"), [role="button"]:has-text("${label}")`).first();
    if (await btn.isVisible().catch(() => false)) {
      await btn.click().catch(() => {});
      await page.waitForTimeout(600);
    }
  }
  await page.waitForTimeout(500);
  await page.screenshot({ path: imgPath, fullPage: true }).catch(() => {});
  return imgPath;
}

// Thrown when the real Instacart cart can't be read or doesn't match what Munchy
// expects. Always raised BEFORE checkout, so no money is spent.
class CartCheckError extends Error {
  constructor(message, details = '') {
    super(message);
    this.name = 'CartCheckError';
    this.details = details;
  }
}

async function openCartPanel(page) {
  const cartBtn = page.locator([
    'a[href*="/cart"]',
    'button[aria-label*="cart" i]',
    'a[aria-label*="cart" i]',
  ].join(', ')).first();
  await cartBtn.click({ timeout: 8000 });
  await page.waitForTimeout(2500);
}

// Read the line items in this store's Instacart cart.
// Returns [{ name, qty }] (qty null when the page doesn't expose it),
// [] for an empty cart, or null if the cart couldn't be read.
async function readCart(page, slug) {
  await page.goto(`https://www.instacart.com/store/${slug}/storefront`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForTimeout(3000);
  await dismissPopups(page);
  try {
    await openCartPanel(page);
  } catch {
    return null;
  }

  const result = await page.evaluate(() => {
    const goBtn = [...document.querySelectorAll('button, a')].find(el => /go to checkout/i.test(el.textContent || ''));
    if (!goBtn) {
      const text = document.body.innerText || '';
      return /cart is empty|your cart is empty|no items in (your )?cart/i.test(text) ? { lines: [] } : null;
    }

    // Walk up from the checkout button to the panel that holds the product rows
    let panel = goBtn.parentElement;
    while (panel && panel !== document.body && !panel.querySelector('li img, [role="listitem"] img')) {
      panel = panel.parentElement;
    }
    if (!panel || panel === document.body) return null;

    const rows = [...panel.querySelectorAll('li, [role="listitem"]')]
      .filter(r => r.querySelector('img') && !r.querySelector('li, [role="listitem"]'));
    if (!rows.length) return null;

    const readQty = (row) => {
      const select = row.querySelector('select');
      if (select && /^\d+$/.test(select.value)) return parseInt(select.value, 10);
      for (const el of row.querySelectorAll('[aria-label]')) {
        const m = el.getAttribute('aria-label').match(/(?:quantity|qty)\D{0,12}(\d+)/i);
        if (m) return parseInt(m[1], 10);
      }
      for (const el of row.querySelectorAll('button, span, div')) {
        if (el.children.length) continue;
        const m = (el.textContent || '').trim().match(/^(?:qty:?\s*)?(\d{1,3})$/i);
        if (m) return parseInt(m[1], 10);
      }
      return null;
    };

    return {
      lines: rows.map(row => {
        const alt = (row.querySelector('img')?.getAttribute('alt') || '').trim();
        const textLine = (row.innerText || '').split('\n').map(l => l.trim())
          .find(l => l.length > 3 && !/^\$/.test(l) && /[a-z]{3}/i.test(l));
        return { name: alt.length > 3 ? alt : (textLine || ''), qty: readQty(row) };
      }).filter(l => l.name),
    };
  }).catch(() => null);

  return result ? result.lines : null;
}

// Add one product to the cart `count` times. Prefers the exact product page we
// saved when the item was added in Slack; falls back to a search, but only clicks
// Add inside a result whose title matches the item.
async function addProduct(page, slug, group, count, alreadyInCart, onProgress) {
  let scope;
  if (group.productUrl) {
    await page.goto(group.productUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(3000);
    scope = page.locator('[role="dialog"], main').first();
    if (!(await scope.isVisible().catch(() => false))) scope = page.locator('body');
  } else {
    const searchUrl = `https://www.instacart.com/store/${slug}/s?k=${encodeURIComponent(group.name)}`;
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(3000);
    const firstClause = group.name.split(',')[0].trim();
    scope = page.locator('li, [role="listitem"]')
      .filter({ hasText: firstClause })
      .filter({ has: page.locator('button') })
      .first();
    await scope.waitFor({ state: 'visible', timeout: 8000 }).catch(() => {
      throw new Error(`no search result titled like "${firstClause}"`);
    });
  }

  let remaining = count;
  if (!alreadyInCart) {
    const addBtn = scope.locator('button[aria-label*="Add to cart" i], button:has-text("Add to cart"), button:text-is("Add")').first();
    await addBtn.waitFor({ state: 'visible', timeout: 8000 });
    await addBtn.click();
    await page.waitForTimeout(2000);
    remaining -= 1;
  }

  if (remaining > 0) {
    const incBtn = scope.locator([
      'button[aria-label*="Increment" i]',
      'button[aria-label*="Increase" i]',
      'button[aria-label*="Add one" i]',
      'button[aria-label*="Add 1" i]',
    ].join(', ')).first();
    try {
      await incBtn.waitFor({ state: 'visible', timeout: 5000 });
    } catch {
      // Cart verification will catch the wrong quantity before checkout
      onProgress(`Couldn't find quantity control for "${group.name}" — cart check will flag it`);
      return;
    }
    for (let n = 0; n < remaining; n++) {
      await incBtn.click();
      await page.waitForTimeout(800);
    }
  }
}

async function placeOrder(store, items, onProgress) {
  const slug = STORE_SLUGS[store] || store.toLowerCase();
  onProgress(`Starting ${store} order — ${items.length} item(s)…`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote', '--single-process'],
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
  });
  await injectSessionCookies(context);
  const page = await context.newPage();
  const ts = Date.now();
  const shot = (label) => page.screenshot({ path: `/tmp/order-${ts}-${label}.png` }).catch(() => {});

  const failedItems = [];
  const failedIds = [];
  const groups = groupCartItems(items);

  try {
    // Read the real Instacart cart before touching it. Leftovers from an earlier
    // run (or items someone added by hand) would otherwise be checked out silently.
    onProgress('Checking current Instacart cart…');
    const before = await readCart(page, slug);
    await shot('cart-before');
    if (!before) throw new CartCheckError(`Couldn't read the ${store} Instacart cart, so nothing was added or ordered.`);
    const pre = reconcileCart(groups, before);
    if (pre.unexpected.length) {
      throw new CartCheckError(
        `The ${store} Instacart cart already has items Munchy didn't add. Nothing was added or ordered.`,
        describeMismatch({ missing: [], unexpected: pre.unexpected, qtyMismatch: [] }),
      );
    }
    const alreadyInCart = new Map(pre.matched.map(m => [m.group, m.line.qty ?? m.group.qty]));

    // Add each distinct product once, then bump it to the right quantity
    for (let i = 0; i < groups.length; i++) {
      const group = groups[i];
      const have = alreadyInCart.get(group) || 0;
      const need = group.qty - have;
      if (need <= 0) {
        onProgress(`Already in cart: ${group.qty}× "${group.name}" ✓`);
        continue;
      }
      onProgress(`Adding ${need}× "${group.name}" (${i + 1}/${groups.length})…`);
      try {
        await addProduct(page, slug, group, need, have > 0, onProgress);
        onProgress(`Added ${need}× "${group.name}" ✓`);
        await shot(`added-${i}`);
      } catch (err) {
        onProgress(`Could not add "${group.name}": ${err.message}`);
        failedItems.push(group.name);
        failedIds.push(...group.ids);
        await shot(`failed-${i}`);
      }
    }

    // Verify the Instacart cart matches exactly what we meant to buy before checkout
    onProgress('Verifying Instacart cart before checkout…');
    const after = await readCart(page, slug);
    await shot('cart-after');
    if (!after) throw new CartCheckError(`Couldn't read the ${store} Instacart cart to verify it, so the order was NOT placed.`);
    const expected = groups.filter(g => !failedItems.includes(g.name));
    if (!expected.length) throw new CartCheckError(`None of the ${store} items could be added, so the order was NOT placed.`);
    const post = reconcileCart(expected, after);
    if (!isCartClean(post)) {
      throw new CartCheckError(
        `The ${store} Instacart cart doesn't match Munchy's cart, so the order was NOT placed.`,
        describeMismatch(post),
      );
    }
    onProgress(`Cart verified: ${expected.length} product(s) match ✓`);

    // readCart leaves the cart panel open; reopen it if something closed it
    const goBtn = page.locator('button:has-text("Go to checkout"), a:has-text("Go to checkout")').first();
    if (!(await goBtn.isVisible().catch(() => false))) {
      await openCartPanel(page);
      await shot('checkout1');
    }
    await goBtn.waitFor({ state: 'visible', timeout: 8000 });
    await goBtn.click({ force: true });
    await page.waitForTimeout(4000);
    await shot('checkout2');

    onProgress('On checkout page — waiting for it to load…');

    // Step 1: Instacart shows a delivery-time picker first; click "Continue" to proceed.
    // The skeleton can take up to 60s to resolve on headless Chromium.
    const continueBtn = page.locator([
      'button:has-text("Continue")',
      'a:has-text("Continue")',
    ].join(', ')).first();

    try {
      await continueBtn.waitFor({ state: 'visible', timeout: 60_000 });
      await shot('before-continue');
      onProgress('Clicking Continue (delivery time confirmation)…');
      await continueBtn.click();
      await page.waitForTimeout(2000);
      await shot('after-continue');

      // Instacart may show a "Mobile number" (or similar) interstitial modal.
      // The phone number is pre-filled — click Continue inside the dialog to proceed.
      try {
        const dialogContinue = page.locator('[role="dialog"] button:has-text("Continue")');
        await dialogContinue.waitFor({ state: 'visible', timeout: 5000 });
        await shot('modal-before');
        onProgress('Confirming phone number in modal…');
        await dialogContinue.click();
        await page.waitForTimeout(2000);
        await shot('modal-after');
      } catch {
        // No modal — that's fine
      }
    } catch {
      // Some flows skip this step — fall through to Place order directly
      onProgress('No Continue button found — proceeding to Place order…');
      await shot('no-continue');
    }

    // Step 2 of 2: "Delivery Tip" modal — click "Confirm & pay" to place the order
    try {
      const tipConfirm = page.locator('[role="dialog"] button:has-text("Confirm & pay")');
      await tipConfirm.waitFor({ state: 'visible', timeout: 10_000 });
      await shot('tip-modal');
      onProgress('Confirming tip and placing order…');
      await tipConfirm.click();
      await page.waitForTimeout(5000);
      const finalUrl = page.url();
      const success = /confirm|thank|order[_-]?detail/i.test(finalUrl);
      const pdfPath = await saveOrderPdf(page, finalUrl, ts);
      const ordered = items.filter(i => !failedIds.includes(i.id));
      const total = ordered.reduce((s, i) => s + i.price, 0);
      const driveLink = await saveReceipt(pdfPath, finalUrl, store, total, ordered).catch(() => null);
      onProgress(success ? `Order placed! ${finalUrl}` : `Submitted — verify at ${finalUrl}`);
      return { success, url: finalUrl, driveLink, failedItems, failedIds };
    } catch {
      // No tip modal — fall through to look for Place order button
    }

    // Fallback: wait for the final "Place order" button
    const placeBtn = page.locator([
      'button:has-text("Place order")',
      'button:has-text("Place your order")',
      'button:has-text("Confirm & pay")',
      'button[data-testid*="place"]',
    ].join(', ')).first();

    await placeBtn.waitFor({ state: 'visible', timeout: 45_000 });
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1000);
    await shot('before-place');

    onProgress('Placing order…');
    await placeBtn.click();
    await page.waitForTimeout(5000);
    const finalUrl = page.url();
    const success = /confirm|thank|order[_-]?detail/i.test(finalUrl);
    const pdfPath = await saveOrderPdf(page, finalUrl, ts);
    const ordered = items.filter(i => !failedIds.includes(i.id));
    const total = ordered.reduce((s, i) => s + i.price, 0);
    const driveLink = await saveReceipt(pdfPath, finalUrl, store, total, ordered).catch(() => null);
    onProgress(success ? `Order placed! ${finalUrl}` : `Submitted — verify at ${finalUrl}`);
    return { success, url: finalUrl, driveLink, failedItems, failedIds };

  } catch (err) {
    await shot('error');
    throw err;
  } finally {
    await browser.close();
  }
}

module.exports = { placeOrder, CartCheckError };
