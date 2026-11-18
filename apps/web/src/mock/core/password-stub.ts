/** Mock mode accepts any password, so the shared seeder's password hashing is a no-op in the browser. */
export async function hashPassword(_password: string): Promise<string> {
  return 'mock';
}

export async function verifyPassword(_password: string, _hash: string): Promise<boolean> {
  return true;
}
