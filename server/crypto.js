/**
 * 敏感字段加密（AES-256-GCM）。
 *
 * 密钥来自 data/.secret（首次运行自动生成，权限 600），可用环境变量 NUAN_SECRET 覆盖。
 * 目的：让「备份/误发 app.db」不会连带泄露模型 API Key。
 * 注意：这不是防本机管理员，拿到 .secret + app.db 的人仍可解密。
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PREFIX = 'enc:v1:';
const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

let cachedKey = null;
let warned = false;

function secretFile() {
  const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'app.db');
  return path.join(path.dirname(dbPath), '.secret');
}

function loadKey() {
  if (cachedKey) return cachedKey;

  const fromEnv = process.env.NUAN_SECRET;
  if (fromEnv) {
    cachedKey = crypto.createHash('sha256').update(fromEnv).digest();
    return cachedKey;
  }

  const file = secretFile();
  try {
    const raw = fs.readFileSync(file, 'utf8').trim();
    if (raw.length === 64) {
      cachedKey = Buffer.from(raw, 'hex');
      return cachedKey;
    }
  } catch {
    /* 不存在则生成 */
  }

  const key = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, key.toString('hex'), { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* Windows 下可能不支持，忽略 */
  }
  cachedKey = key;
  return cachedKey;
}

function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

function encrypt(plain) {
  if (!plain) return '';
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, loadKey(), iv);
  const body = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, body]).toString('base64');
}

function decrypt(value) {
  if (!value) return '';
  // 兼容历史明文：不是密文就原样返回，交给上层迁移
  if (!isEncrypted(value)) return String(value);

  try {
    const buf = Buffer.from(value.slice(PREFIX.length), 'base64');
    const iv = buf.subarray(0, IV_LEN);
    const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const body = buf.subarray(IV_LEN + TAG_LEN);
    const decipher = crypto.createDecipheriv(ALGO, loadKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  } catch {
    if (!warned) {
      warned = true;
      console.warn(
        '\n⚠ 有加密字段无法解密（data/.secret 可能被删除或替换），请在设置里重新填写 API Key。\n',
      );
    }
    return '';
  }
}

module.exports = { encrypt, decrypt, isEncrypted, secretFile };
