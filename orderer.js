const { chromium } = require('playwright');

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

async function placeOrder(store, items, onProgress) {
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
    // Add each item to cart by navigating to its product page
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item.product_url) {
        onProgress(`Skipping "${item.name}" — no product URL`);
        continue;
      }

      onProgress(`Adding "${item.name}" (${i + 1}/${items.length})…`);
      await page.goto(item.product_url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.waitForTimeout(2000);
      await shot(`item${i}`);

      const addBtn = page.locator([
        'button:has-text("Add to cart")',
        'button[aria-label*="Add to cart" i]',
        'button:has-text("Add")',
      ].join(', ')).first();

      try {
        await addBtn.click({ timeout: 8000 });
        await page.waitForTimeout(1500);
        onProgress(`Added "${item.name}" ✓`);
      } catch (err) {
        onProgress(`Could not click Add for "${item.name}": ${err.message}`);
      }
    }

    // Go to cart
    onProgress('Navigating to cart…');
    await page.goto('https://www.instacart.com/cart', { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(3000);
    await shot('cart');

    // "Go to checkout" or "Checkout" button
    const checkoutBtn = page.locator([
      'button:has-text("Go to checkout")',
      'a:has-text("Go to checkout")',
      'button:has-text("Checkout")',
    ].join(', ')).first();
    await checkoutBtn.click({ timeout: 10_000 });
    await page.waitForTimeout(4000);
    await shot('checkout1');

    onProgress('On checkout page — handling delivery options…');

    // Pick first available delivery window if a time-picker is visible
    try {
      const firstSlot = page.locator('[data-testid*="timeslot"], button[class*="timeslot"], button[class*="TimeSlot"]').first();
      if (await firstSlot.isVisible({ timeout: 3000 })) {
        await firstSlot.click();
        await page.waitForTimeout(1000);
        onProgress('Selected first delivery window');
      }
    } catch { /* no time picker — already selected or pickup */ }

    await shot('checkout2');

    // Place order
    onProgress('Placing order…');
    const placeBtn = page.locator([
      'button:has-text("Place order")',
      'button:has-text("Place your order")',
      'button[data-testid*="place-order"]',
    ].join(', ')).first();
    await placeBtn.click({ timeout: 15_000 });
    await page.waitForTimeout(5000);
    await shot('placed');

    const finalUrl = page.url();
    const success = /confirm|order[_-]?detail|thank/i.test(finalUrl);
    if (success) {
      onProgress(`Order placed! Confirmation: ${finalUrl}`);
    } else {
      onProgress(`Submitted — final URL: ${finalUrl} (check /tmp/order-${ts}-placed.png)`);
    }
    return { success, url: finalUrl };

  } catch (err) {
    await shot('error');
    throw err;
  } finally {
    await browser.close();
  }
}

module.exports = { placeOrder };
