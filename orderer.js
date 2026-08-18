const { chromium } = require('playwright');
const { saveReceipt } = require('./receipts');

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

  try {
    // Add each item by searching for it in the store
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      // Use first clause of product name (before first comma) as search term
      const searchTerm = item.name.split(',')[0].trim();
      onProgress(`Searching for "${searchTerm}" (${i + 1}/${items.length})…`);

      const searchUrl = `https://www.instacart.com/store/${slug}/s?k=${encodeURIComponent(searchTerm)}`;
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.waitForTimeout(3000);
      await shot(`search-${i}`);

      // Find the "Add" button on the first product card
      // Instacart renders add buttons as "+" or "Add" — grab the first visible one
      const addBtn = page.locator([
        'button[aria-label*="Add to cart" i]',
        'button[aria-label*="Add" i][aria-label*="' + searchTerm.split(' ')[0] + '" i]',
        'button:has-text("+")',
      ].join(', ')).first();

      try {
        await addBtn.waitFor({ state: 'visible', timeout: 8000 });
        await addBtn.click();
        await page.waitForTimeout(2000);
        onProgress(`Added "${item.name}" ✓`);
        await shot(`added-${i}`);
      } catch (err) {
        onProgress(`Could not add "${item.name}": ${err.message}`);
        await shot(`failed-${i}`);
      }
    }

    // Dismiss any blocking dialogs (address picker, promos, etc.) before navigating cart
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    // Also try clicking outside any dialog overlay
    await page.evaluate(() => {
      const overlay = document.querySelector('[data-dialog-ref]');
      if (overlay) overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }).catch(() => {});
    await page.waitForTimeout(500);

    // Click the cart button (top-right) to open the cart panel
    onProgress('Opening cart…');
    const cartBtn = page.locator([
      'a[href*="/cart"]',
      'button[aria-label*="cart" i]',
      'a[aria-label*="cart" i]',
    ].join(', ')).first();
    await cartBtn.click({ timeout: 8000 });
    await page.waitForTimeout(2000);
    await shot('checkout1');

    // "Go to checkout" button in the cart panel — use force:true to bypass any lingering overlay
    const goBtn = page.locator('button:has-text("Go to checkout"), a:has-text("Go to checkout")').first();
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
      const total = items.reduce((s, i) => s + i.price, 0);
      const driveLink = await saveReceipt(pdfPath, finalUrl, store, total, items).catch(() => null);
      onProgress(success ? `Order placed! ${finalUrl}` : `Submitted — verify at ${finalUrl}`);
      return { success, url: finalUrl, driveLink };
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
    const total = items.reduce((s, i) => s + i.price, 0);
    const driveLink = await saveReceipt(pdfPath, finalUrl, store, total, items).catch(() => null);
    onProgress(success ? `Order placed! ${finalUrl}` : `Submitted — verify at ${finalUrl}`);
    return { success, url: finalUrl, driveLink };

  } catch (err) {
    await shot('error');
    throw err;
  } finally {
    await browser.close();
  }
}

module.exports = { placeOrder };
