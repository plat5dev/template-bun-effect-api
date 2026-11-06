/**
 * The query keys whose values `url.query` never carries (plat5
 * docs/reference/telemetry.md#http-server-spans). Keys match exactly.
 */
const REDACTED_QUERY_KEYS: ReadonlySet<string> = new Set([
  "sig",
  "Signature",
  "AWSAccessKeyId",
  "X-Amz-Signature",
  "X-Amz-Credential",
  "X-Amz-Security-Token",
  "X-Goog-Signature"
])

/**
 * The raw query, without its `?`, with the value of each redacted key replaced by
 * REDACTED. Every other key and value is kept as sent.
 */
export const redactQuery = (query: string): string =>
  query
    .split("&")
    .map((part) => {
      const eq = part.indexOf("=")
      return eq >= 0 && REDACTED_QUERY_KEYS.has(part.slice(0, eq)) ? `${part.slice(0, eq)}=REDACTED` : part
    })
    .join("&")
