/**
 * Now, in UTC, as RFC 3339 with the fraction's trailing zeros dropped (no fraction on a
 * whole second): the form Go's time.RFC3339Nano writes, to the millisecond.
 */
export const now = (date = new Date()): string => date.toISOString().replace(/\.?0+Z$/, "Z")
