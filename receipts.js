const { google } = require('googleapis');
const fs = require('fs');

function getAuth() {
  let json = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!json && process.env.GOOGLE_SERVICE_ACCOUNT_JSON_B64)
    json = Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_JSON_B64, 'base64').toString('utf8');
  if (!json) return null;
  return new google.auth.GoogleAuth({
    credentials: JSON.parse(json),
    scopes: [
      'https://www.googleapis.com/auth/drive.file',
      'https://www.googleapis.com/auth/spreadsheets',
    ],
  });
}

async function uploadReceipt(filePath, fileName) {
  const auth = getAuth();
  const folderId = process.env.GOOGLE_DRIVE_RECEIPTS_FOLDER_ID;
  if (!auth || !folderId) {
    console.log('[receipts] Drive not configured — skipping upload');
    return null;
  }

  const isPdf = filePath.endsWith('.pdf');
  const mimeType = isPdf ? 'application/pdf' : 'image/png';
  const drive = google.drive({ version: 'v3', auth });

  try {
    const res = await drive.files.create({
      requestBody: { name: fileName, parents: [folderId] },
      media: { mimeType, body: fs.createReadStream(filePath) },
      fields: 'id,webViewLink',
      supportsAllDrives: true,
    });
    console.log(`[receipts] uploaded: ${res.data.webViewLink}`);
    return res.data.webViewLink;
  } catch (err) {
    console.error('[receipts] Drive upload failed:', err.message);
    return null;
  }
}

async function logSpend(total, items, driveLink) {
  const auth = getAuth();
  const sheetId = process.env.GOOGLE_SHEETS_SPEND_ID;
  if (!auth || !sheetId) {
    console.log('[receipts] Sheets not configured — skipping log');
    return;
  }

  const sheets = google.sheets({ version: 'v4', auth });
  // MM/DD/YYYY to match existing sheet format
  const now = new Date();
  const date = `${now.getMonth() + 1}/${now.getDate()}/${now.getFullYear()}`;
  const itemList = items.map(i => i.name).join(', ');

  // A: Date | B: Total | C: blank | D: Food & Beverage | E: item list | F: Drive link | G: notes
  try {
    // Detect the first sheet's actual name (avoids 'Sheet1' locale mismatch)
    const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
    const tabName = meta.data.sheets[0].properties.title;
    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: `${tabName}!A:G`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[date, total, '', 'Food & Beverage', itemList, driveLink || '', 'Created with the Snackbot']],
      },
    });
    console.log(`[receipts] spend logged to Sheets tab "${tabName}"`);
  } catch (err) {
    console.error('[receipts] Sheets log failed:', err.message);
  }
}

async function saveReceipt(filePath, orderUrl, store, total, items) {
  // Build filename from order URL: "August 18, 2026 - Order #abc123.pdf"
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const orderMatch = orderUrl.match(/\/store\/orders\/([A-Za-z0-9_-]+)/) ||
                     orderUrl.match(/\/orders?\/([A-Za-z0-9_-]+)/) ||
                     orderUrl.match(/[?&]order[_-]?(?:id|num(?:ber)?)=([A-Za-z0-9_-]+)/i);
  const orderNum = orderMatch ? orderMatch[1] : now.getTime().toString();
  const fileName = `${dateStr} - Order #${orderNum}.png`;

  // Upload first, then log with the link
  const driveLink = await uploadReceipt(filePath, fileName);
  await logSpend(total, items, driveLink);
  return driveLink;
}

module.exports = { saveReceipt };
