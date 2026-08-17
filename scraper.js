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
  await page.waitForTimeout(2000);

  try {
    const addressInput = page.locator([
      'input[placeholder*="ddress" i]',
      'input[placeholder*="ip code" i]',
      '[data-testid="address-input"]',
      '[aria-label*="address" i]',
    ].join(', ')).first();

    await addressInput.click({ timeout: 6000 });
    await addressInput.fill(DELIVERY_ADDRESS);
    await page.waitForTimeout(1800);

    const suggestion = page.locator(
      '[data-testid="address-suggestion"], [role="option"], .pac-item, li[class*="suggestion"]'
    ).first();
    await suggestion.click({ timeout: 6000 });
    await page.waitForTimeout(2500);
  } catch {
    // Silent fallback — scrape using direct store URLs anyway
  }
}

async function scrapeStore(page, store, query) {
  const url = `https://www.instacart.com/store/${store.slug}/search_v3/${encodeURIComponent(query)}`;

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(3000);

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

    // Debug: capture what Instacart actually shows
    const pageTitle = await page.title();
    const pageUrl = page.url();
    console.log(`[${store.name}] title="${pageTitle}" url=${pageUrl}`);
    await page.screenshot({ path: `/tmp/debug-${store.slug}.png`, fullPage: false });

    const products = await page.evaluate(() => {
      const selectors = [
        '[data-testid="item-card"]',
        'article[class*="ItemCard"]',
        'li[class*="item-card"]',
        '[class*="item_card"]',
        'li[class*="ItemBrowser"]',
        '[data-testid="search-result-item"]',
      ];
      console.log('Trying selectors:', selectors.map(s => `${s}:${document.querySelectorAll(s).length}`).join(', '));
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
    await setDeliveryAddress(page);

    for (const store of STORES) {
      const products = await scrapeStore(page, store, query);
      onStoreResult({ store: store.name, products });
    }
  } finally {
    await browser.close();
  }
}

module.exports = { scrapeInstacart };
