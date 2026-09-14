// SwitchBot button → cart item mapping.
// Keys are device IDs from the SwitchBot API (no separators, uppercase).
// To find a new Plug Mini's ID after pairing: node scripts/find-new-devices.js
// Add more entries here as new buttons are installed.

module.exports = {
  '10003BC17BBA': {   // "Coffee Button" Plug Mini
    label: 'Coffee',
    emoji: '☕',
    store: 'Costco',
    name: 'Mayorga Organic Artesano Blend Coffee, Whole Bean, Medium Roast, 2 lbs',
    price: 17.28,
    size: '2 lbs',
    crisisMessage: '☕ *The Hippo Campus is out of coffee! Oh no! Please fix this crisis.*',
  },

  '58E6C584C7FE': {   // "Sparkling Water Button" Plug Mini
    label: 'Sparkling Water',
    emoji: '💧',
    store: 'Costco',
    // Fallback if unavailable: 'Kirkland Signature Sparkling Water Variety Pack'
    name: 'LaCroix Dazzling Delicious Sparkling Water Variety Pack',
    price: 22.99,
    size: '',
    crisisMessage: '💧 *The Hippo Campus is out of sparkling water! Oh no! Please fix this crisis.*',
  },

  '58E6C5848FB2': {
    label: 'Toilet Paper (Left)',
    emoji: '🧻',
    store: 'Costco',
    name: 'Kirkland Signature Ultra Soft Bath Tissue, 2-Ply, 231 Sheets, 36 Rolls',
    price: 27.36,
    size: '36 Rolls',
    crisisMessage: '🧻 *The Hippo Campus is out of toilet paper! Oh no! Please fix this crisis.*',
  },

  '10003BC165B2': {
    label: 'Toilet Paper (Right)',
    emoji: '🧻',
    store: 'Costco',
    name: 'Kirkland Signature Ultra Soft Bath Tissue, 2-Ply, 231 Sheets, 36 Rolls',
    price: 27.36,
    size: '36 Rolls',
    crisisMessage: '🧻 *The Hippo Campus is out of toilet paper! Oh no! Please fix this crisis.*',
  },
};
