#!/usr/bin/env node
/**
 * Usage:
 *   npm run create-code -- <BASE_URL> <CODE> [USES_REMAINING] [EXPIRES_AT_ISO]
 *
 * Example (local dev):
 *   ADMIN_TOKEN=super-secret-admin-token npm run create-code -- http://127.0.0.1:8787 EXPERT-1234
 *
 * Notes:
 * - BASE_URL is your worker origin (no trailing /api), e.g. http://127.0.0.1:8787 or https://<worker>.workers.dev
 * - The endpoint is protected by ADMIN_TOKEN. Set it via `wrangler secret put ADMIN_TOKEN`.
 */
const [baseUrl, code, usesStr, expiresAt] = process.argv.slice(2);
if (!baseUrl || !code) {
  console.error("Usage: npm run create-code -- <BASE_URL> <CODE> [USES_REMAINING] [EXPIRES_AT_ISO]");
  process.exit(1);
}

const adminToken = process.env.ADMIN_TOKEN || "";
if (!adminToken) {
  console.error("Missing ADMIN_TOKEN env var. Set it (e.g. ADMIN_TOKEN=... npm run create-code -- ...).");
  process.exit(1);
}

const payload = {
  code,
};
if (usesStr !== undefined) payload.uses_remaining = Number(usesStr);
if (expiresAt !== undefined) payload.expires_at = String(expiresAt);

const url = `${baseUrl.replace(/\/+$/, "")}/api/admin/register_code`;

(async () => {
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Admin-Token": adminToken,
    },
    body: JSON.stringify(payload),
  });
  const txt = await r.text();
  if (!r.ok) {
    console.error("Error", r.status, txt);
    process.exit(2);
  }
  console.log(txt);
})();
