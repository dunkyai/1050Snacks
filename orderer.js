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

    // "Go to checkout" button in the cart panel
    const goBtn = page.locator('button:has-text("Go to checkout"), a:has-text("Go to checkout")').first();
    await goBtn.waitFor({ state: 'visible', timeout: 8000 });
    await goBtn.click();
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

      // Instacart may show a "Mobile number" (or similar) interstitial modal — dismiss it
      try {
        const modalClose = page.locator([
          'button[aria-label*="close" i]',
          'button[aria-label*="dismiss" i]',
          '[role="dialog"] button:has(svg)',
          '[role="dialog"] button:first-child',
        ].join(', ')).first();
        await modalClose.waitFor({ state: 'visible', timeout: 5000 });
        await modalClose.click();
        await page.waitForTimeout(1500);
        await shot('dismissed-modal');
        onProgress('Dismissed interstitial modal…');
      } catch {
        // No modal — that's fine
      }
    } catch {
      // Some flows skip this step — fall through to Place order directly
      onProgress('No Continue button found — proceeding to Place order…');
      await shot('no-continue');
    }

    // Step 2: Now wait for the final "Place order" button
    const placeBtn = page.locator([
      'button:has-text("Place order")',
      'button:has-text("Place your order")',
      'button:has-text("Confirm order")',
      'button:has-text("Submit order")',
      'button[data-testid*="place"]',
      'button[data-testid*="submit"]',
      'button[data-testid*="confirm"]',
    ].join(', ')).first();

    await placeBtn.waitFor({ state: 'visible', timeout: 45_000 });
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1000);
    await shot('before-place');

    onProgress('Placing order…');
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
