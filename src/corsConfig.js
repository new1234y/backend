/**
 * CLIENT_ORIGIN : une origine, plusieurs séparées par des virgules, ou * (réseau local / dev).
 */
export function corsOriginOption(raw) {
  if (typeof raw !== 'string') {
    return true;
  }
  const v = raw.trim();
  if (!v || v === "*") return true;
  const list = v.split(",").map((s) => s.trim()).filter(Boolean);
  if (list.length === 0) return true;
  if (list.length === 1) return list[0];
  return list;
}
