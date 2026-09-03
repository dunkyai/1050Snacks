# How to Add a New Refill Button

Follow these steps each time you want to add a new item (sparkling water, toilet paper, etc.).

---

## What you need

- One SwitchBot Plug Mini (US)
- One SwitchBot Remote (already set up)
- The SwitchBot app on your phone
- The `SWITCHBOT_TOKEN` and `SWITCHBOT_SECRET` from the GitHub repo secrets (or ask someone who has them)

---

## Step 1 — Pair the Plug Mini

1. Plug the Plug Mini into a wall outlet near where you want it.
2. Hold the button on the Plug Mini for 2 seconds until it blinks rapidly.
3. Open the SwitchBot app → tap **+** → **Add Device** → select **Plug Mini (US)**.
4. Follow the in-app pairing steps.
5. **Name it clearly** — e.g. "Sparkling Water Button" or "Toilet Paper Button".
6. Tap Done.

---

## Step 2 — Link the Remote button to the Plug Mini

1. In the SwitchBot app, tap the Remote device.
2. Tap the button you want to use (e.g. top-left).
3. Tap **Edit** (pencil icon) → **Create Scene**.
4. Tap **Add Action** → select the Plug Mini you just paired → choose **Turn On** → Save.
5. Repeat for any additional buttons.

> Each button must trigger **Turn On** (not Toggle). The server auto-turns it off after 2 seconds.

---

## Step 3 — Find the Plug Mini's device ID

In your terminal, from the `1050Snacks` directory:

```bash
SWITCHBOT_TOKEN=<your_token> SWITCHBOT_SECRET=<your_secret> node scripts/find-new-devices.js
```

You'll see output like:

```
── All Plug Minis ──────────────────────────────
✓ Coffee Button        10003BC17BBA  (configured)
★ Sparkling Water Button  A1B2C3D4E5F6  ← ADD THIS TO switchbot-items.js
```

Copy the ID next to your new device (e.g. `A1B2C3D4E5F6`).

---

## Step 4 — Find the right product name

In Slack, run a `/snacks` search for the item:

```
/snacks sparkling water
/snacks toilet paper
```

Pick the product you want and note the exact name and price shown.

---

## Step 5 — Update `switchbot-items.js`

Open `switchbot-items.js` and uncomment (or add) the entry for your item. Replace the placeholder device ID with the real one from Step 3, and the product name/price with what you found in Step 4:

```js
'A1B2C3D4E5F6': {
  label: 'Sparkling Water',
  emoji: '💧',
  store: 'Costco',
  name: 'Kirkland Signature Sparkling Water',
  price: 14.99,
  size: '35-pack',
  crisisMessage: '💧 *The Hippo Campus is out of sparkling water! Oh no! Please fix this crisis.*',
},
```

---

## Step 6 — Commit and deploy

```bash
git add switchbot-items.js
git commit -m "add <item> button"
git push origin main
```

GitHub Actions will build and deploy automatically (~2 min). Once it's live, press the Remote button to test — you should see a Slack message in the shopping channel.

---

## Configured buttons

| Item          | Device ID      | Remote Button |
|---------------|----------------|---------------|
| Coffee        | 10003BC17BBA   | TBD           |
| Sparkling Water | (not yet paired) | TBD        |
| Toilet Paper  | (not yet paired) | TBD          |

Update this table as you add each button.
