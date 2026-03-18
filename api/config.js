// Vercel Serverless Function – serves Firebase config from environment variables.
// The actual secret values live in Vercel Dashboard → Settings → Environment Variables.
// This file is safe to push to a public GitHub repository.

export default function handler(req, res) {
  // Basic origin check (optional extra layer)
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    apiKey:            process.env.FIREBASE_API_KEY,
    authDomain:        process.env.FIREBASE_AUTH_DOMAIN,
    databaseURL:       process.env.FIREBASE_DATABASE_URL,
    projectId:         process.env.FIREBASE_PROJECT_ID,
    storageBucket:     process.env.FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
    appId:             process.env.FIREBASE_APP_ID,
  });
}
