const jwt = require('jsonwebtoken');

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Please log in first.' });

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET || 'local-only-change-me');
    return next();
  } catch {
    return res.status(401).json({ error: 'Session is invalid or expired. Please log in again.' });
  }
}

function makeToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, name: user.name },
    process.env.JWT_SECRET || 'local-only-change-me',
    { expiresIn: '7d' }
  );
}

module.exports = { requireAuth, makeToken };
