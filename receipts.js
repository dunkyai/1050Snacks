const { google } = require('googleapis');
const fs = require('fs');

function getAuth() {
  const json = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!json) return null;
  return new google.auth.GoogleAuth({
    credentials: JSON.parse(json),
    scopes: [
      'https://www.googleapis.com/auth/drive.file',
      'https://www.googleapis.com/auth/spreadsheets',
    ],
  });
}

async function uploadReceipt(screenshotPath, store, total, itemCount) {
  const auth = getAuth();
  const folderId = process.env.GOOGLE_DRIVE_RECEIPTS_FOLDER_ID;
  if (!auth || !folderId) {
    console.log('[receipts] Drive not configured — skipping upload');
    return null;
  }

  const drive = google.drive({ version: 'v3', auth });
  const date = new Date().toISOString().slice(0, 10);
  const fileName = `${store}-order-${date}-$${total.toFixed(2)}.png`;

  try {
    const res = await drive.files.create({
      requestBody: { name: fileName, parents: [folderId] },
      media: { mimeType: 'image/png', body: fs.createReadStream(screenshotPath) },
      fields: 'id,webViewLink',
    });
    console.log(`[receipts] uploaded: ${res.data.webViewLink}`);
    return res.data.webViewLink;
  } catch (err) {
    console.error('[receipts] Drive upload failed:', err.message);
    return null;
  }
}

async function logSpend(store, total, itemCount, driveLink) {
  const auth = getAuth();
  const sheetId = process.env.GOOGLE_SHEETS_SPEND_ID;
  if (!auth || !sheetId) {
    console.log('[receipts] Sheets not configured — skipping log');
    return;
  }

  const sheets = google.sheets({ version: 'v4', auth });
  const date = new Date().toISOString().slice(0, 10);

  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: 'Sheet1!A:E',
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[date, store, itemCount, total, driveLink || '']],
      },
    });
    console.log('[receipts] spend logged to Sheets');
  } catch (err) {
    console.error('[receipts] Sheets log failed:', err.message);
  }
}

async function saveReceipt(screenshotPath, store, total, itemCount) {
  const driveLink = await uploadReceipt(screenshotPath, store, total, itemCount);
  await logSpend(store, total, itemCount, driveLink);
  return driveLink;
}

module.exports = { saveReceipt };
