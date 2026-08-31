import bcrypt from 'bcryptjs';

// Optional per-post delete password, same semantics as the old schema:
// null/undefined hash = "anyone can delete"; otherwise bcrypt-verify unless
// the caller is an admin (checked separately by the function using this).
export async function hashPassword(plain) {
  if (!plain) return null;
  return bcrypt.hash(plain, 10);
}

export async function verifyPassword(plain, hash) {
  if (!hash) return true; // no password set on this post
  if (!plain) return false;
  return bcrypt.compare(plain, hash);
}
