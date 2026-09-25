const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 100;
const ADMIN_RATE_LIMIT_MAX = 10;

/**
 * Creates a per-socket, per-event sliding-window limiter.
 * The returned function keeps the existing server contract: true means allow.
 */
export function createRateLimiter() {
  const eventsByKey = new Map();

  return function checkRateLimit(socketId, eventName) {
    const key = `${socketId}:${eventName}`;
    const now = Date.now();
    const windowStart = now - RATE_LIMIT_WINDOW_MS;
    const events = eventsByKey.get(key) || [];
    const recentEvents = events.filter((timestamp) => timestamp > windowStart);
    eventsByKey.set(key, recentEvents);

    const maxLimit = eventName.startsWith("admin_")
      ? ADMIN_RATE_LIMIT_MAX
      : RATE_LIMIT_MAX;

    if (recentEvents.length >= maxLimit) {
      console.warn(`Rate limit exceeded for ${eventName} from socket ${socketId}`);
      return false;
    }

    recentEvents.push(now);
    return true;
  };
}
