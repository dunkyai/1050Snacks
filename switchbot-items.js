// SwitchBot button → cart item mapping.
// Keys are device IDs from the SwitchBot API (no separators, uppercase).
// To find a new Plug Mini's ID after pairing: node scripts/find-new-devices.js
// Add more entries here as new buttons are installed.

module.exports = {
  '10003BC17BBA': {   // "Coffee Button" Plug Mini
    label: 'Coffee',
    emoji: '☕',
    store: 'Costco',
    name: 'Mr. Comfort Organic Peru Coffee',
    price: 22.38,
    size: '',
    crisisMessage: '☕ *The Hippo Campus is out of coffee! Oh no! Please fix this crisis.*',
  },

  // ── TODO: replace SPARKLING-WATER-PLUG-ID with real device ID ──────────────
  // After pairing the Plug Mini: node scripts/find-new-devices.js
  // 'SPARKLING-WATER-PLUG-ID': {
  //   label: 'Sparkling Water',
  //   emoji: '💧',
  //   store: 'Costco',
  //   name: 'Kirkland Signature Sparkling Water',
  //   price: 14.99,
  //   size: '35-pack',
  //   crisisMessage: '💧 *The Hippo Campus is out of sparkling water! Oh no! Please fix this crisis.*',
  // },

  // ── TODO: replace TOILET-PAPER-PLUG-ID with real device ID ────────────────
  // After pairing the Plug Mini: node scripts/find-new-devices.js
  // 'TOILET-PAPER-PLUG-ID': {
  //   label: 'Toilet Paper',
  //   emoji: '🧻',
  //   store: 'Costco',
  //   name: 'Kirkland Signature Bath Tissue',
  //   price: 31.99,
  //   size: '30-count',
  //   crisisMessage: '🧻 *The Hippo Campus is out of toilet paper! Oh no! Please fix this crisis.*',
  // },
};
