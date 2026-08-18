const assert = require('assert');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    failed++;
  }
}

// ── Inline the pure functions under test ─────────────────────────────────────

function extractOrderNumber(url) {
  const m = url.match(/\/orders?\/([A-Za-z0-9_-]+)/) ||
            url.match(/[?&]order[_-]?(?:id|num(?:ber)?)=([A-Za-z0-9_-]+)/i);
  return m ? m[1] : null;
}

function parseServings(title, size) {
  const text = `${title} ${size || ''}`;
  const countMatch = text.match(
    /(\d+)\s*(?:count|ct\.?|pack|pcs|pieces|bars?|bags?|pouches?|cups?|bottles?|cans?|snacks?|cookies|crackers|servings?)/i
  ) || text.match(/(\d+)-(?:count|ct|pack)/i) || text.match(/pack\s+of\s+(\d+)/i);
  if (countMatch) return { count: parseInt(countMatch[1], 10), basis: 'count' };
  const lbMatch = text.match(/(\d+(?:\.\d+)?)\s*lb/i);
  if (lbMatch) { const oz = Math.round(parseFloat(lbMatch[1]) * 16); return { count: oz, basis: `est. ${oz} servings (1/oz)` }; }
  const ozMatch = text.match(/(\d+(?:\.\d+)?)\s*oz/i);
  if (ozMatch) { const count = Math.round(parseFloat(ozMatch[1])); return { count, basis: `est. ${count} servings (1/oz)` }; }
  const gMatch = text.match(/(\d+(?:\.\d+)?)\s*g\b/i);
  if (gMatch) { const count = Math.round(parseFloat(gMatch[1]) / 28); return { count, basis: `est. ${count} servings (28g each)` }; }
  return null;
}

function isIndividualPack(p) {
  const text = `${p.name} ${p.size || ''}`.toLowerCase();
  const smallMultipack = /\b(0\.\d+|1|1\.[0-9])\s*oz\b/.test(text) && /\b(\d+[\s-]count|pack|variety)\b/.test(text);
  const keywords = /snack\s*pack|individual|single[\s-]serve|fun\s+size|mini\s+bag|on[\s-]the[\s-]go/i.test(text);
  return smallMultipack || keywords;
}

function buildSheetRow(total, items, driveLink) {
  const now = new Date('2026-08-18T15:00:00Z');
  const date = `${now.getMonth() + 1}/${now.getDate()}/${now.getFullYear()}`;
  const itemList = items.map(i => i.name).join(', ');
  return [date, total, '', 'Food & Beverage', itemList, driveLink || '', 'Created with the Snackbot'];
}

// ── Tests ─────────────────────────────────────────────────────────────────────

console.log('\nOrder number extraction:');
test('extracts from /orders/<id>/confirm', () => {
  assert.strictEqual(extractOrderNumber('https://www.instacart.com/orders/abc123/confirm'), 'abc123');
});
test('extracts from /order/<id>', () => {
  assert.strictEqual(extractOrderNumber('https://www.instacart.com/order/XYZ-789'), 'XYZ-789');
});
test('extracts from ?order_id= query param', () => {
  assert.strictEqual(extractOrderNumber('https://www.instacart.com/thank_you?order_id=def456'), 'def456');
});
test('extracts from ?order-id= query param', () => {
  assert.strictEqual(extractOrderNumber('https://www.instacart.com/confirm?order-id=GHI_012'), 'GHI_012');
});
test('returns null when no order number in URL', () => {
  assert.strictEqual(extractOrderNumber('https://www.instacart.com/store/costco/storefront'), null);
});

console.log('\nServing size parser:');
test('parses count from "48 count"', () => {
  assert.strictEqual(parseServings('Kirkland Trail Mix 48 Count', '').count, 48);
});
test('parses count from "36-count"', () => {
  assert.strictEqual(parseServings('Kind Bars 36-count', '').count, 36);
});
test('parses count from "pack of 24"', () => {
  assert.strictEqual(parseServings('Clif Bars pack of 24', '').count, 24);
});
test('parses oz to estimated servings', () => {
  assert.strictEqual(parseServings('Kettle Chips', '16 oz').count, 16);
});
test('parses lb to estimated servings', () => {
  assert.strictEqual(parseServings('Mixed Nuts', '2 lb').count, 32);
});
test('returns null for unknown size', () => {
  assert.strictEqual(parseServings('Mystery Snack', ''), null);
});

console.log('\nIndividual pack detection:');
test('detects snack pack keyword', () => {
  assert.ok(isIndividualPack({ name: 'Goldfish Snack Packs', size: '1 oz' }));
});
test('detects single-serve keyword', () => {
  assert.ok(isIndividualPack({ name: 'Oreos Single-Serve', size: '' }));
});
test('detects small oz multipack', () => {
  assert.ok(isIndividualPack({ name: 'Lays Chips', size: '1 oz 30 count' }));
});
test('does not flag a bulk bag', () => {
  assert.ok(!isIndividualPack({ name: 'Kirkland Mixed Nuts', size: '40 oz' }));
});

console.log('\nSheets row format:');
test('correct column order and values', () => {
  const items = [{ name: 'Diet Coke 35-pack' }, { name: 'Kirkland Granola Bars 36 count' }];
  const row = buildSheetRow(42.50, items, 'https://drive.google.com/file/abc');
  assert.strictEqual(row[0], '8/18/2026');        // A: date
  assert.strictEqual(row[1], 42.50);               // B: total
  assert.strictEqual(row[2], '');                  // C: blank
  assert.strictEqual(row[3], 'Food & Beverage');   // D: category
  assert.ok(row[4].includes('Diet Coke'));          // E: item list
  assert.ok(row[4].includes('Kirkland'));
  assert.ok(row[5].includes('drive.google.com'));  // F: Drive link
  assert.strictEqual(row[6], 'Created with the Snackbot'); // G: notes
});
test('handles missing drive link', () => {
  const row = buildSheetRow(10, [{ name: 'Chips' }], null);
  assert.strictEqual(row[5], '');
});

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
