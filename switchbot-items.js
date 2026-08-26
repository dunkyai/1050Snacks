// SwitchBot button → cart item mapping.
// Find a device's MAC in the SwitchBot app: Devices → tap device → ··· → Device Info → BLE MAC.
// Add more entries here as new buttons are installed.

module.exports = {
  'XX:XX:XX:XX:XX:XX': {        // Coffee machine button — replace with real MAC after setup
    label: 'Coffee',
    emoji: '☕',
    store: 'Costco',
    name: 'TBD — confirm coffee brand first',   // update after running /snacks coffee
    price: 0,
    size: '',
  },
};
