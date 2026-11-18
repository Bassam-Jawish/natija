import * as crypto from 'node:crypto';
import { config } from '../config';

export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function hmac(value: string): string {
  return crypto.createHmac('sha256', config.secret).update(value).digest('base64url');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

type Argon2Fn = (
  algorithm: 'argon2id',
  params: { message: Buffer; nonce: Buffer; parallelism: number; tagLength: number; memory: number; passes: number },
  cb: (err: Error | null, key: Buffer) => void,
) => void;

const argon2 = (crypto as unknown as { argon2?: Argon2Fn }).argon2;
const ARGON = { memory: 19_456, passes: 2, parallelism: 1, tagLength: 32 };

function argon2id(password: string, salt: Buffer, p = ARGON): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    argon2!('argon2id', { message: Buffer.from(password, 'utf8'), nonce: salt, ...p }, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

function scrypt(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    crypto.scrypt(password, salt, 32, { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

/** Argon2id (built into Node 24.7+), PHC-formatted. Falls back to scrypt on older runtimes. */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  if (argon2) {
    const key = await argon2id(password, salt);
    return `$argon2id$v=19$m=${ARGON.memory},t=${ARGON.passes},p=${ARGON.parallelism}$${salt.toString('base64')}$${key.toString('base64')}`;
  }
  const key = await scrypt(password, salt);
  return `$scrypt$n=16384,r=8,p=1$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  // ['', alg, ...]
  if (parts[1] === 'argon2id' && argon2) {
    const params = Object.fromEntries(parts[3]!.split(',').map((kv) => kv.split('=') as [string, string]));
    const salt = Buffer.from(parts[4]!, 'base64');
    const expected = Buffer.from(parts[5]!, 'base64');
    const key = await argon2id(password, salt, {
      memory: Number(params.m),
      passes: Number(params.t),
      parallelism: Number(params.p),
      tagLength: expected.length,
    });
    return crypto.timingSafeEqual(key, expected);
  }
  if (parts[1] === 'scrypt') {
    const salt = Buffer.from(parts[3]!, 'base64');
    const expected = Buffer.from(parts[4]!, 'base64');
    const key = await scrypt(password, salt);
    return crypto.timingSafeEqual(key, expected);
  }
  return false;
}
