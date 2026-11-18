import * as crypto from 'node:crypto';

type Argon2Fn = (
  algorithm: 'argon2id',
  params: { message: Buffer; nonce: Buffer; parallelism: number; tagLength: number; memory: number; passes: number },
  cb: (err: Error | null, key: Buffer) => void,
) => void;

const argon2 = (crypto as unknown as { argon2?: Argon2Fn }).argon2;

/** Same PHC format and parameters as apps/api/src/lib/crypto.ts. */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  if (argon2) {
    const key = await new Promise<Buffer>((resolve, reject) =>
      argon2('argon2id', { message: Buffer.from(password), nonce: salt, parallelism: 1, tagLength: 32, memory: 19_456, passes: 2 }, (e, k) =>
        e ? reject(e) : resolve(k),
      ),
    );
    return `$argon2id$v=19$m=19456,t=2,p=1$${salt.toString('base64')}$${key.toString('base64')}`;
  }
  const key = await new Promise<Buffer>((resolve, reject) =>
    crypto.scrypt(password, salt, 32, { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (e, k) => (e ? reject(e) : resolve(k))),
  );
  return `$scrypt$n=16384,r=8,p=1$${salt.toString('base64')}$${key.toString('base64')}`;
}
