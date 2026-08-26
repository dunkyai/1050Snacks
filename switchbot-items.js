// SwitchBot button → cart item mapping.
// Keys are device IDs from the SwitchBot API (no separators, uppercase).
// Add more entries here as new buttons are installed.

module.exports = {
  'B0E9FEE66CBA': {   // "Coffee" Remote
    label: 'Coffee',
    emoji: '☕',
    store: 'Costco',
    name: 'Mr. Comfort Organic Peru Coffee',
    price: 22.38,   // approximate — actual Instacart price applies at order time
    size: '',
  },
  'B0E9FE62D580': {   // "Snacks" Remote
    label: 'Snacks',
    emoji: '🍿',
    store: 'Costco',
    name: 'TBD',
    price: 0,
    size: '',
  },
};
