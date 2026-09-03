#!/usr/bin/env node
// Run this after pairing a new Plug Mini to find its device ID.
// Usage: node scripts/find-new-devices.js

const crypto = require('crypto');
const path = require('path');

const TOKEN = process.env.SWITCHBOT_TOKEN;
const SECRET = process.env.SWITCHBOT_SECRET;

if (!TOKEN || !SECRET) {
  console.error('Set SWITCHBOT_TOKEN and SWITCHBOT_SECRET env vars first.');
  process.exit(1);
}

const CONFIGURED = Object.keys(require('../switchbot-items.js'));

async function main() {
  const t = Date.now().toString();
  const nonce = crypto.randomUUID();
  const sign = crypto.createHmac('sha256', SECRET).update(TOKEN + t + nonce).digest('base64');
  const res = await fetch('https://api.switch-bot.com/v1.1/devices', {
    headers: { 'Authorization': TOKEN, 'sign': sign, 't': t, 'nonce': nonce },
  });
  const data = await res.json();
  const plugs = data.body.deviceList.filter(d => d.deviceType.toLowerCase().includes('plug'));

  console.log('\n── All Plug Minis ──────────────────────────────');
  for (const p of plugs) {
    const configured = CONFIGURED.includes(p.deviceId);
    console.log(`${configured ? '✓' : '★'} ${p.deviceName.padEnd(20)} ${p.deviceId}  ${configured ? '(configured)' : '← ADD THIS TO switchbot-items.js'}`);
  }
  console.log('');
}

main().catch(err => { console.error(err.message); process.exit(1); });
