/**
 * CLIENT_ORIGIN : une origine, plusieurs séparées par des virgules, ou * (réseau local / dev).
 * SECURITY: Wildcard (*) is only allowed in development mode.
 */
export function corsOriginOption(raw) {
  if (typeof raw !== 'string') {
    // In production, reject invalid CORS config instead of allowing wildcard
    if (process.env.NODE_ENV === 'production') {
      console.error('SECURITY: Invalid CLIENT_ORIGIN configuration in production');
      return process.env.CLIENT_ORIGIN || false;
    }
    return true; // Allow in development only
  }
  const v = raw.trim();
  
  // SECURITY: Only allow wildcard in development
  if (!v || v === "*") {
    if (process.env.NODE_ENV === 'production') {
      console.error('SECURITY: Wildcard CORS origin not allowed in production');
      return process.env.CLIENT_ORIGIN || false;
    }
    return true;
  }
  
  const list = v.split(",").map((s) => s.trim()).filter(Boolean);
  if (list.length === 0) {
    if (process.env.NODE_ENV === 'production') {
      return process.env.CLIENT_ORIGIN || false;
    }
    return true;
  }
  if (list.length === 1) return list[0];
  return list;
}
