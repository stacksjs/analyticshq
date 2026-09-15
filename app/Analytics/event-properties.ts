/**
 * Browser keepalive requests have a small total-body budget. Keeping event
 * properties below 48 KiB leaves room for the event envelope while allowing
 * long URLs and useful structured metadata.
 */
export const MAX_EVENT_PROPERTIES_BYTES = 48 * 1024

const URL_EVENTS = new Set(['Outbound Link', 'File Download'])

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

/**
 * Serialize public event properties without allowing an unbounded database
 * value. Reserved URL events keep one canonical key so grouping is stable.
 *
 * Invalid or oversized properties are omitted, but the event itself can still
 * be recorded. The public collector must not become a 500 because optional
 * metadata was unusable.
 */
export function serializeEventProperties(event: unknown, properties: unknown): string | null {
  if (properties === null || properties === undefined)
    return null

  let normalized = properties
  if (
    URL_EVENTS.has(String(event))
    && typeof properties === 'object'
    && 'url' in properties
    && properties.url
  ) {
    normalized = { url: String(properties.url) }
  }

  try {
    const serialized = JSON.stringify(normalized)
    if (!serialized || utf8Bytes(serialized) > MAX_EVENT_PROPERTIES_BYTES)
      return null

    return serialized
  }
  catch {
    return null
  }
}
