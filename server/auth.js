/**
 * 单密码门禁：scrypt 哈希 + 会话 Cookie。
 * 只服务单用户场景，不做多账号。
 */
const crypto = require('node:crypto');
const { db, getSetting, setSetting, deleteSetting } = require('./db');

const COOKIE = 'nuan_session';
const SESSION_TTL = 1000 * 60 * 60 * 24 * 30; // 30 天
const MIN_PASSWORD = 4;

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 32).toString('hex');
}

function isConfigured() {
  return !!getSetting('password_hash');
}

function setPassword(password) {
  if (typeof password !== 'string' || password.trim().length < MIN_PASSWORD) {
    throw new Error(`密码至少 ${MIN_PASSWORD} 位`);
  }
  const salt = crypto.randomBytes(16).toString('hex');
  setSetting('password_salt', salt);
  setSetting('password_hash', hashPassword(password, salt));
}

function verifyPassword(password) {
  const salt = getSetting('password_salt');
  const hash = getSetting('password_hash');
  if (!salt || !hash) return false;
  const got = Buffer.from(hashPassword(String(password), salt), 'hex');
  const want = Buffer.from(hash, 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  const t = Date.now();
  db.prepare('INSERT INTO sessions (token, created_at, expires_at) VALUES (?, ?, ?)').run(
    token,
    t,
    t + SESSION_TTL,
  );
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(t);
  return token;
}

function readToken(req) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return decodeURIComponent(v.join('='));
  }
  return null;
}

function isAuthed(req) {
  const token = readToken(req);
  if (!token) return false;
  const row = db.prepare('SELECT expires_at FROM sessions WHERE token = ?').get(token);
  if (!row) return false;
  if (row.expires_at < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return false;
  }
  return true;
}

function setSessionCookie(res, token) {
  const maxAge = Math.floor(SESSION_TTL / 1000);
  res.setHeader(
    'Set-Cookie',
    `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`,
  );
}

function clearSessionCookie(res, req) {
  const token = readToken(req);
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function resetPassword() {
  deleteSetting('password_hash');
  deleteSetting('password_salt');
  db.prepare('DELETE FROM sessions').run();
}

// 登录失败限速：同一进程内 10 次/分钟
const attempts = new Map();
function tooManyAttempts(ip) {
  const t = Date.now();
  const list = (attempts.get(ip) || []).filter((x) => t - x < 60_000);
  attempts.set(ip, list);
  return list.length >= 10;
}
function recordAttempt(ip) {
  const list = attempts.get(ip) || [];
  list.push(Date.now());
  attempts.set(ip, list);
}

module.exports = {
  COOKIE,
  isConfigured,
  setPassword,
  verifyPassword,
  createSession,
  isAuthed,
  setSessionCookie,
  clearSessionCookie,
  resetPassword,
  tooManyAttempts,
  recordAttempt,
};
