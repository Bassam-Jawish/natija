# Security

Patient results are sensitive. These controls are built in; they are a design target (OWASP ASVS level 2 as a checklist), **not a certification**. A security review by someone other than the builder, and a legal review under Syrian rules (see [deployment](deployment.md#where-patient-data-may-live)), are needed before real patients.

| Threat | Controls in the code |
| --- | --- |
| Reading another lab's data | Lab from the session only; PostgreSQL row-level security forced on every lab table; lab-scoped composite foreign keys; 404 for foreign ids; isolation tests |
| Account takeover | Argon2id password hashes (Node's built-in implementation); 5 wrong passwords lock the account for 15 minutes; 10 sign-in attempts per IP per minute; same response for unknown users (timing equalised); sessions expire after 12 h and 2 h idle; password change signs out everywhere |
| CSRF / XSS / injection | SameSite=Lax httpOnly cookie + HMAC CSRF token header on every state change; strict Content-Security-Policy (no inline scripts), React escaping, SVG logo sanitiser; parameterised SQL only (Drizzle); zod validation of every input |
| Wrong person changing or approving results | Server-side permission checks per route; entry and validation by different people by default (segregation of duties); validation and amendments require the password again (e-signature); validated results can't be edited, only amended into a new version with a reason |
| Forwarded or guessed patient links | 256-bit random link tokens (only the hash is stored), 6-digit access code printed on the receipt, 5 wrong codes lock the link, expiry, rate limits, every view logged |
| Forged printed reports | QR code to a public verification page showing the lab, order number, version, release date and content hash, but no results |
| Stolen or copied Lab Agent | One-time 24-hour enrolment code, per-device token (hash stored), revocable; agent endpoints can only post messages and read worklists for their own lab |
| Tampering with history | Append-only audit log (the app role can't UPDATE/DELETE it) with a per-lab sha256 hash chain and a "verify chain" check |
| Data loss | Nightly backups in the Compose stack; restore procedure in [deployment](deployment.md); clinical records are never hard-deleted |
| Secrets | Read from the environment only; production refuses to start with the development secret; `.env` is git-ignored |

Logging redacts cookies, authorization headers and CSRF tokens. Error responses carry stable codes without stack traces.
