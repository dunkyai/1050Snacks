const { chromium } = require('playwright');

const DELIVERY_ADDRESS = '1050 Sansome St, San Francisco, CA 94111';

const STORES = [
  { name: 'Costco',  slug: 'costco-warehouse' },
  { name: 'Safeway', slug: 'safeway' },
];

function parseServings(title, size) {
  const text = `${title} ${size || ''}`;

  const countMatch = text.match(
    /(\d+)\s*(?:count|ct\.?|pack|pcs|pieces|bars?|bags?|pouches?|cups?|bottles?|cans?|snacks?|cookies|crackers|servings?)/i
  ) || text.match(/(\d+)-(?:count|ct|pack)/i) || text.match(/pack\s+of\s+(\d+)/i);
  if (countMatch) return { count: parseInt(countMatch[1], 10), basis: 'count' };

  const lbMatch = text.match(/(\d+(?:\.\d+)?)\s*lb/i);
  if (lbMatch) {
    const oz = Math.round(parseFloat(lbMatch[1]) * 16);
    return { count: oz, basis: `est. ${oz} servings (1/oz)` };
  }

  const ozMatch = text.match(/(\d+(?:\.\d+)?)\s*oz/i);
  if (ozMatch) {
    const count = Math.round(parseFloat(ozMatch[1]));
    return { count, basis: `est. ${count} servings (1/oz)` };
  }

  const gMatch = text.match(/(\d+(?:\.\d+)?)\s*g\b/i);
  if (gMatch) {
    const count = Math.round(parseFloat(gMatch[1]) / 28);
    return { count, basis: `est. ${count} servings (28g each)` };
  }

  return null;
}

// Load the Instacart homepage and extract store URLs from the store list.
// The server IP resolves to SF Bay Area so stores are already shown.
async function loadHomepageAndGetStoreUrls(page) {
  await page.goto('https://www.instacart.com', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: '/tmp/debug-homepage.png' });
  console.log('Homepage loaded, URL:', page.url());

  // Pull all store links visible on the homepage
  const storeLinks = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a[href*="/store/"]'));
    return links.map(a => ({
      href: a.href,
      text: a.innerText?.trim() || a.getAttribute('aria-label') || '',
    })).filter(l => l.href && !l.href.includes('/search'));
  });

  console.log('Store links found:', storeLinks.map(l => `${l.text}: ${l.href}`).join(' | '));
  return storeLinks;
}

function pickStoreUrl(storeLinks, storeName) {
  const name = storeName.toLowerCase();
  // Exact text match first
  let match = storeLinks.find(l => l.text.toLowerCase().startsWith(name));
  // Slug-based fallback
  if (!match) match = storeLinks.find(l => l.href.toLowerCase().includes(name.replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')));
  return match ? match.href.split('?')[0] : null;
}

async function scrapeStore(page, storeLinks, store, query) {
  try {
    // Navigate to the store storefront (click path, not search URL directly)
    const storefrontUrl = pickStoreUrl(storeLinks, store.name)
      || `https://www.instacart.com/store/${store.slug}/storefront`;
    console.log(`[${store.name}] going to storefront: ${storefrontUrl}`);

    await page.goto(storefrontUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(2000);
    await page.screenshot({ path: `/tmp/debug-${store.slug}-front.png` });
    console.log(`[${store.name}] storefront url after nav: ${page.url()}`);

    // Use the search box on the storefront — avoids direct /search_v3/ URL which 404s without a session
    const searchInput = page.locator('input[placeholder*="Search" i], input[aria-label*="Search" i]').first();
    await searchInput.click({ timeout: 8000 });
    await searchInput.fill(query);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(3000);
    await page.screenshot({ path: `/tmp/debug-${store.slug}-search.png` });
    console.log(`[${store.name}] search page: ${page.url()} — title: ${await page.title()}`);

    await page.waitForSelector(
      '[data-testid="item-card"], article[class*="ItemCard"], [class*="item-card"], li[class*="item"]',
      { timeout: 12_000 }
    );

    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => window.scrollBy(0, 600));
      await page.waitForTimeout(800);
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(500);

    const products = await page.evaluate(() => {
      const selectors = [
        '[data-testid="item-card"]',
        'article[class*="ItemCard"]',
        'li[class*="item-card"]',
        '[class*="item_card"]',
        'li[class*="ItemBrowser"]',
        '[data-testid="search-result-item"]',
      ];
      let cards = [];
      for (const sel of selectors) {
        cards = Array.from(document.querySelectorAll(sel));
        if (cards.length) break;
      }

      return cards.slice(0, 10).map(card => {
        const nameEl = card.querySelector(
          '[data-testid*="name" i], [data-testid*="title" i], h2, h3, a[class*="name" i]'
        );
        const name = nameEl?.textContent?.trim() || null;

        const priceEl = card.querySelector(
          '[data-testid*="price" i], [aria-label*="$"], [class*="price"]'
        );
        const priceText = priceEl?.textContent?.trim() || priceEl?.getAttribute('aria-label') || '';
        const priceMatch = priceText.match(/\$([\d,.]+)/);
        const price = priceMatch ? parseFloat(priceMatch[1].replace(',', '')) : null;

        const sizeEl = card.querySelector(
          '[data-testid*="size" i], [data-testid*="unit" i], [class*="size"], [class*="unit"], small'
        );
        const size = sizeEl?.textContent?.trim() || '';

        return { name, price, size };
      }).filter(p => p.name && p.price);
    });

    return products.map(p => {
      const servings = parseServings(p.name, p.size);
      return {
        ...p,
        servings: servings ? servings.count : null,
        servingsBasis: servings ? servings.basis : null,
        pricePerMeal: servings ? +(p.price / servings.count).toFixed(2) : null,
      };
    }).sort((a, b) => (a.pricePerMeal ?? Infinity) - (b.pricePerMeal ?? Infinity));

  } catch (err) {
    console.error(`[${store.name}] scrape error: ${err.message}`);
    await page.screenshot({ path: `/tmp/debug-${store.slug}-error.png` }).catch(() => {});
    return [];
  }
}

// Cookie-Editor exports an array of cookie objects; Playwright wants a slightly different shape.
async function injectSessionCookies(context) {
  const b64 = process.env.INSTACART_COOKIES_B64;
  const raw = b64
    ? Buffer.from(b64, 'base64').toString('utf8')
    : process.env.INSTACART_COOKIES;

  if (!raw) {
    console.log('No session cookies configured — running without login');
    return;
  }

  const exported = JSON.parse(raw);

  // Cookie-Editor sameSite values differ from Playwright's expected values
  const sameSiteMap = { strict: 'Strict', lax: 'Lax', no_restriction: 'None', none: 'None' };

  const cookies = exported
    .map(c => ({
      name: c.name,
      value: c.value,
      // hostOnly cookies must not have a leading dot
      domain: c.hostOnly ? c.domain.replace(/^\./, '') : (c.domain.startsWith('.') ? c.domain : `.${c.domain}`),
      path: c.path || '/',
      expires: c.expirationDate ? Math.floor(c.expirationDate) : -1,
      httpOnly: c.httpOnly ?? false,
      secure: c.secure ?? false,
      sameSite: sameSiteMap[(c.sameSite || '').toLowerCase()] ?? 'Lax',
    }))
    .filter(c => c.name && c.value);

  await context.addCookies(cookies);
  console.log(`Injected ${cookies.length} session cookies`);
}

async function scrapeInstacart(query, onStoreResult) {
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-zygote',
      '--single-process',
    ],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
  });

  await injectSessionCookies(context);
  const page = await context.newPage();

  try {
    const storeLinks = await loadHomepageAndGetStoreUrls(page);

    for (const store of STORES) {
      const products = await scrapeStore(page, storeLinks, store, query);
      onStoreResult({ store: store.name, products });
    }
  } finally {
    await browser.close();
  }
}

module.exports = { scrapeInstacart };
