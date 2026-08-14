// Expone el Client ID público de Google al front (no es secreto).
module.exports = (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.status(200).json({ googleClientId: process.env.GOOGLE_CLIENT_ID || '' });
};
