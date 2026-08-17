const { chromium } = require('playwright');

const STORE_SLUGS = { Costco: 'costco', Safeway: 'safeway' };

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

    // Navigate to the store's cart / checkout
    onProgress('Going to checkout…');
    const cartUrl = `https://www.instacart.com/store/${slug}/checkout`;
    await page.goto(cartUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(3000);
    await shot('checkout1');

    // Some flows land on a cart summary page first — look for "Go to checkout"
    try {
      const goBtn = page.locator('button:has-text("Go to checkout"), a:has-text("Go to checkout")').first();
      if (await goBtn.isVisible({ timeout: 3000 })) {
        await goBtn.click();
        await page.waitForTimeout(3000);
        await shot('checkout2');
      }
    } catch { /* already on checkout */ }

    onProgress('Handling delivery options…');

    // Pick first available delivery time slot if visible
    try {
      const slot = page.locator('[data-testid*="timeslot"], button[class*="timeslot" i], button[class*="TimeSlot"]').first();
      if (await slot.isVisible({ timeout: 3000 })) {
        await slot.click();
        await page.waitForTimeout(1000);
        onProgress('Selected delivery window');
      }
    } catch { /* no picker shown */ }

    await shot('before-place');

    // Place order
    onProgress('Placing order…');
    const placeBtn = page.locator([
      'button:has-text("Place order")',
      'button:has-text("Place your order")',
      'button[data-testid*="place"]',
    ].join(', ')).first();
    await placeBtn.waitFor({ state: 'visible', timeout: 15_000 });
    await placeBtn.click();
    await page.waitForTimeout(5000);
    await shot('placed');

    const finalUrl = page.url();
    const success = /confirm|thank|order[_-]?detail/i.test(finalUrl);
    onProgress(success ? `Order placed! ${finalUrl}` : `Submitted — verify at ${finalUrl}`);
    return { success, url: finalUrl };

  } catch (err) {
    await shot('error');
    throw err;
  } finally {
    await browser.close();
  }
}

module.exports = { placeOrder };
