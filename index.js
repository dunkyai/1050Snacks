#!/usr/bin/env node

const { chromium } = require('playwright');
const readline = require('readline');

const DELIVERY_ADDRESS = '1050 Sansome St, San Francisco, CA 94111';

const STORES = [
  { name: 'Costco',  slug: 'costco-warehouse' },
  { name: 'Safeway', slug: 'safeway' },
];

// ── CLI prompt ────────────────────────────────────────────────────────────────

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => { rl.close(); resolve(answer.trim()); });
  });
}

// ── Serving size parser ───────────────────────────────────────────────────────
// Tries to extract a snack-meal count from a product title + size string.
// Falls back to weight-based estimates (1 serving ≈ 1 oz for most dry snacks).

function parseServings(title, size) {
  const text = `${title} ${size || ''}`;

  // Explicit count: "48 count", "12 ct", "30 pack", "24 bars", etc.
  const countMatch = text.match(
    /(\d+)\s*(?:count|ct\.?|pack|pcs|pieces|bars?|bags?|pouches?|cups?|bottles?|cans?|snacks?|cookies|crackers|servings?)/i
  ) || text.match(/(\d+)-(?:count|ct|pack)/i) || text.match(/pack\s+of\s+(\d+)/i);
  if (countMatch) return { count: parseInt(countMatch[1], 10), basis: 'count' };

  // Pound-based → convert to oz → estimate 1 serving/oz
  const lbMatch = text.match(/(\d+(?:\.\d+)?)\s*lb/i);
  if (lbMatch) {
    const oz = Math.round(parseFloat(lbMatch[1]) * 16);
    return { count: oz, basis: `${lbMatch[1]} lb → ~${oz} oz, est. 1 serving/oz` };
  }

  // Ounce-based → estimate 1 serving/oz
  const ozMatch = text.match(/(\d+(?:\.\d+)?)\s*oz/i);
  if (ozMatch) {
    const count = Math.round(parseFloat(ozMatch[1]));
    return { count, basis: `${ozMatch[1]} oz, est. 1 serving/oz` };
  }

  // Gram-based → estimate 28 g/serving
  const gMatch = text.match(/(\d+(?:\.\d+)?)\s*g\b/i);
  if (gMatch) {
    const count = Math.round(parseFloat(gMatch[1]) / 28);
    return { count, basis: `${gMatch[1]} g, est. 28 g/serving` };
  }

  return null;
}

// ── Instacart address setup ───────────────────────────────────────────────────

async function setDeliveryAddress(page) {
  console.log('Setting delivery address...');
  await page.goto('https://www.instacart.com', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForTimeout(2000);

  try {
    // Try to find and click the address input (various selectors Instacart has used)
    const addressInput = page.locator([
      'input[placeholder*="ddress" i]',
      'input[placeholder*="ip code" i]',
      '[data-testid="address-input"]',
      '[aria-label*="address" i]',
    ].join(', ')).first();

    await addressInput.click({ timeout: 6000 });
    await page.waitForTimeout(500);
    await addressInput.fill(DELIVERY_ADDRESS);
    await page.waitForTimeout(1800);

    // Select the first autocomplete suggestion
    const suggestion = page.locator([
      '[data-testid="address-suggestion"]',
      '[role="option"]',
      '.pac-item',
      'li[class*="suggestion"]',
    ].join(', ')).first();
    await suggestion.click({ timeout: 6000 });
    await page.waitForTimeout(2500);

    console.log(`✓ Address set: ${DELIVERY_ADDRESS}`);
  } catch {
    console.log('⚠  Could not auto-set address. Please set it manually in the browser window, then press Enter here.');
    await prompt('  Press Enter when address is set...');
  }
}

// ── Product scraper for one store ─────────────────────────────────────────────

async function scrapeStore(page, store, query) {
  const url = `https://www.instacart.com/store/${store.slug}/search_v3/${encodeURIComponent(query)}`;
  console.log(`\nSearching ${store.name}...`);

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(3000);

    // Wait for at least one product card to appear
    await page.waitForSelector(
      '[data-testid="item-card"], article[class*="ItemCard"], [class*="item-card"], li[class*="item"]',
      { timeout: 12_000 }
    );

    // Scroll to trigger lazy loading
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => window.scrollBy(0, 600));
      await page.waitForTimeout(800);
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(500);

    const products = await page.evaluate(() => {
      // Try multiple card container selectors
      const selectors = [
        '[data-testid="item-card"]',
        'article[class*="ItemCard"]',
        'li[class*="item-card"]',
        '[class*="item_card"]',
      ];

      let cards = [];
      for (const sel of selectors) {
        cards = Array.from(document.querySelectorAll(sel));
        if (cards.length > 0) break;
      }

      return cards.slice(0, 10).map(card => {
        // Name — try data-testid first, then headings, then links
        const nameEl = card.querySelector(
          '[data-testid*="name" i], [data-testid*="title" i], h2, h3, a[class*="name" i]'
        );
        const name = nameEl?.textContent?.trim() || null;

        // Price — look for $ sign or price data-testid
        const priceEl = card.querySelector(
          '[data-testid*="price" i], [aria-label*="$"], [class*="price"]'
        );
        const priceText = priceEl?.textContent?.trim() || priceEl?.getAttribute('aria-label') || '';
        const priceMatch = priceText.match(/\$([\d,.]+)/);
        const price = priceMatch ? parseFloat(priceMatch[1].replace(',', '')) : null;

        // Size / quantity — often in a secondary label
        const sizeEl = card.querySelector(
          '[data-testid*="size" i], [data-testid*="unit" i], [class*="size"], [class*="unit"], small'
        );
        const size = sizeEl?.textContent?.trim() || '';

        return { name, price, size };
      }).filter(p => p.name && p.price);
    });

    return products;
  } catch (err) {
    console.log(`  ⚠  ${store.name} failed: ${err.message}`);
    return [];
  }
}

// ── Results display ───────────────────────────────────────────────────────────

function printResults(store, products, query) {
  const hr = '─'.repeat(62);
  console.log(`\n${'═'.repeat(62)}`);
  console.log(`  ${store.name.toUpperCase()}  ·  "${query}"`);
  console.log('═'.repeat(62));

  if (!products.length) {
    console.log('  No results found (store may not carry this or blocked).');
    return;
  }

  // Sort by price-per-meal (cheapest first), unknowns at end
  const withServings = products.map(p => ({ ...p, servings: parseServings(p.name, p.size) }));
  withServings.sort((a, b) => {
    const aPpm = a.servings ? a.price / a.servings.count : Infinity;
    const bPpm = b.servings ? b.price / b.servings.count : Infinity;
    return aPpm - bPpm;
  });

  for (const p of withServings) {
    const ppm = p.servings ? `$${(p.price / p.servings.count).toFixed(2)}/snack-meal` : 'unknown';
    const meals = p.servings ? `${p.servings.count} snack-meals  (${p.servings.basis})` : 'serving count unknown';

    console.log(`\n  ${p.name}`);
    if (p.size) console.log(`  Size:           ${p.size}`);
    console.log(`  Price:          $${p.price.toFixed(2)}`);
    console.log(`  Snack-meals:    ${meals}`);
    console.log(`  Per meal:       ${ppm}`);
    console.log(`  ${hr}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n🛒  1050 Sansome Snack Finder\n');

  const query = await prompt('What type of snacks are you looking for?\n> ');
  if (!query) { console.error('No snack type entered.'); process.exit(1); }

  console.log('\nLaunching browser...');
  const browser = await chromium.launch({
    headless: false,
    slowMo: 40,
    args: ['--window-size=1280,900'],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
  });

  const page = await context.newPage();

  await setDeliveryAddress(page);

  const allResults = [];
  for (const store of STORES) {
    const products = await scrapeStore(page, store, query);
    allResults.push({ store, products });
  }

  await browser.close();

  console.log('\n\n════════════════════════════════════════════════════════════');
  console.log(`  RESULTS FOR: "${query}" — delivered to 1050 Sansome St, SF`);
  for (const { store, products } of allResults) {
    printResults(store, products, query);
  }

  console.log('\n✓ Done\n');
}

main().catch(err => {
  console.error('\nFatal error:', err.message);
  process.exit(1);
});
