const encoder = new TextEncoder();

async function getKey(usage) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET not configured");
  return crypto.subtle.importKey(
    "raw", encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false, usage
  );
}

export async function createToken(payload) {
  const key = await getKey(["sign"]);
  const data = JSON.stringify({ ...payload, exp: Date.now() + 7 * 24 * 60 * 60 * 1000 });
  const dataB64 = Buffer.from(data).toString("base64url");
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(dataB64));
  const sigB64 = Buffer.from(sig).toString("base64url");
  return `${dataB64}.${sigB64}`;
}

export async function verifyToken(token) {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [dataB64, sigB64] = parts;
  try {
    const key = await getKey(["verify"]);
    const sigBytes = Buffer.from(sigB64, "base64url");
    const valid = await crypto.subtle.verify("HMAC", key, sigBytes, encoder.encode(dataB64));
    if (!valid) return null;
    const payload = JSON.parse(Buffer.from(dataB64, "base64url").toString());
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}
