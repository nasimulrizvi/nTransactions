const express = require('express');
const compression = require('compression');
const path = require('path');

const app = express();
const PORT = 3000;

app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Serverless API handlers
const aiChatHandler = require('./api/ai-chat.js');
const geminiVoiceHandler = require('./api/gemini-voice.js');
const shortenHandler = require('./api/shorten.js');
const smsParseHandler = require('./api/sms-parse.js');
const sendEmailHandler = require('./api/send-email.js');

app.all('/api/ai-chat', (req, res) => aiChatHandler(req, res));
app.all('/api/gemini-voice', (req, res) => geminiVoiceHandler(req, res));
app.all('/api/shorten', (req, res) => shortenHandler(req, res));
app.all('/api/sms-parse', (req, res) => smsParseHandler(req, res));
app.all('/api/send-email', (req, res) => sendEmailHandler(req, res));

// Static files
app.use(express.static(path.join(__dirname), {
  setHeaders: (res, filepath) => {
    if (filepath.endsWith('version.json')) {
      res.setHeader('Cache-Control', 'no-store, max-age=0');
    } else if (filepath.endsWith('sw.js')) {
      res.setHeader('Cache-Control', 'no-cache, max-age=0');
    }
  }
}));

// Fallback to index.html
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
});
