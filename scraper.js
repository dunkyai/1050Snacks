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

async function setDeliveryAddress(page) {
  await page.goto('https://www.instacart.com', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: '/tmp/debug-homepage.png' });
  console.log('Homepage loaded, URL:', page.url());

  const addressInput = page.locator([
    'input[placeholder*="ddress" i]',
    'input[placeholder*="ip code" i]',
    '[data-testid="address-input"]',
    '[aria-label*="address" i]',
  ].join(', ')).first();

  await addressInput.click({ timeout: 8000 });
  await addressInput.fill(DELIVERY_ADDRESS);
  await page.waitForTimeout(2000);

  const suggestion = page.locator(
    '[data-testid="address-suggestion"], [role="option"], .pac-item, li[class*="suggestion"]'
  ).first();
  await suggestion.click({ timeout: 8000 });
  await page.waitForTimeout(3000);
  console.log('Address set, current URL:', page.url());
}

// Find the store URL by browsing the Instacart store list after address is set
async function findStoreUrl(page, storeName) {
  await page.goto('https://www.instacart.com/store', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `/tmp/debug-storelist.png` });

  // Try text-based link match first
  const storeLink = page.locator(`a[href*="/store/"]:has-text("${storeName}")`).first();
  let href = await storeLink.getAttribute('href', { timeout: 8000 }).catch(() => null);

  // Fallback: aria-label match (store name sometimes in image alt, not visible text)
  if (!href) {
    href = await page.locator(`a[aria-label*="${storeName}" i][href*="/store/"]`)
      .first().getAttribute('href', { timeout: 4000 }).catch(() => null);
  }

  if (!href) throw new Error(`Store link for "${storeName}" not found on /store page`);

  const base = href.startsWith('http') ? href : `https://www.instacart.com${href}`;
  console.log(`[${storeName}] found store URL: ${base}`);
  return base.split('?')[0];
}

async function scrapeStore(page, store, query) {
  try {
    const storeBase = await findStoreUrl(page, store.name).catch(() => {
      console.log(`[${store.name}] store link not found, falling back to slug`);
      return `https://www.instacart.com/store/${store.slug}`;
    });

    const url = `${storeBase}/search_v3/${encodeURIComponent(query)}`;
    console.log(`[${store.name}] searching: ${url}`);

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(3000);
    await page.screenshot({ path: `/tmp/debug-${store.slug}.png` });

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
    return [];
  }
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

  const page = await context.newPage();

  try {
    await setDeliveryAddress(page).catch(err => {
      console.warn('Address setting failed (will use slug URLs):', err.message);
    });

    for (const store of STORES) {
      const products = await scrapeStore(page, store, query);
      onStoreResult({ store: store.name, products });
    }
  } finally {
    await browser.close();
  }
}

module.exports = { scrapeInstacart };
