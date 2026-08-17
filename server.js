const express = require('express');
const path = require('path');
const { scrapeInstacart } = require('./scraper');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

// SSE endpoint — streams results as each store completes
app.get('/search', async (req, res) => {
  const query = (req.query.q || '').trim();
  if (!query) {
    res.status(400).json({ error: 'Missing query parameter ?q=' });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    await scrapeInstacart(query, (result) => send({ type: 'store', ...result }));
    send({ type: 'done' });
  } catch (err) {
    send({ type: 'error', message: err.message });
  }

  res.end();
});

app.listen(PORT, () => console.log(`1050Snacks running on port ${PORT}`));
