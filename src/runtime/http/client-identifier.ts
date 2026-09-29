import { isIP } from 'node:net';

export function extractClientIdentifier(
  socketRemoteAddress: string | undefined,
  forwardedFor: string | string[] | undefined,
  trustForwardedFor: boolean,
): string {
  if (!trustForwardedFor) {
    return socketRemoteAddress || 'unknown';
  }

  const clientAddress = extractForwardedForAddress(forwardedFor);
  return clientAddress || socketRemoteAddress || 'unknown';
}

function extractForwardedForAddress(forwardedFor: string | string[] | undefined): string | null {
  const firstValue = firstForwardedValue(forwardedFor);
  if (firstValue === null) {
    return null;
  }

  const leftMost = firstValue.split(',')[0]?.trim();
  if (!leftMost) {
    return null;
  }

  return normalizeClientAddress(leftMost);
}

function firstForwardedValue(forwardedFor: string | string[] | undefined): string | null {
  if (typeof forwardedFor === 'string') {
    return forwardedFor;
  }

  if (Array.isArray(forwardedFor) && typeof forwardedFor[0] === 'string') {
    return forwardedFor[0];
  }

  return null;
}

/**
 * Reduce a single forwarded address token to a canonical host string, or return
 * `null` when it is not a well-formed IPv4/IPv6 address.
 *
 * Bracketed-IPv6 wrappers (`[::1]`) and `:port` suffixes are stripped, and IPv6
 * is lower-cased and zero-compressed, so equivalent forms collapse to the same
 * rate-limit key. Anything that is not a real IP address is rejected so a
 * malformed header cannot be used as a trusted identity and the caller falls
 * back to the socket address.
 */
function normalizeClientAddress(value: string): string | null {
  if (value.startsWith('[')) {
    const closingBracket = value.indexOf(']');
    if (closingBracket === -1) {
      return null;
    }

    const suffix = value.slice(closingBracket + 1);
    if (suffix !== '' && !isPortSuffix(suffix)) {
      return null;
    }

    const host = value.slice(1, closingBracket);
    return isIP(host) === 6 ? canonicalizeIpv6(host) : null;
  }

  const addressKind = isIP(value);
  if (addressKind === 4) {
    return value;
  }
  if (addressKind === 6) {
    return canonicalizeIpv6(value);
  }

  // IPv4 with a `:port` suffix (a bare IPv6-with-port is ambiguous, so brackets
  // are required for that form).
  const portSeparator = value.lastIndexOf(':');
  if (portSeparator !== -1 && value.indexOf(':') === portSeparator) {
    const port = value.slice(portSeparator + 1);
    const host = value.slice(0, portSeparator);
    if (isPortNumber(port) && isIP(host) === 4) {
      return host;
    }
  }

  return null;
}

function isPortSuffix(value: string): boolean {
  return value.startsWith(':') && isPortNumber(value.slice(1));
}

function isPortNumber(value: string): boolean {
  if (!/^\d{1,5}$/.test(value)) return false;

  const port = Number(value);
  return port >= 1 && port <= 65_535;
}

/** RFC 5952 canonical form for an already-validated IPv6 address. */
function canonicalizeIpv6(address: string): string {
  let input = address.toLowerCase();

  // Fold a trailing embedded IPv4 (e.g. `::ffff:192.0.2.128`) into two hex groups.
  const lastColon = input.lastIndexOf(':');
  const tail = input.slice(lastColon + 1);
  if (tail.includes('.')) {
    const octets = tail.split('.').map((part) => Number(part));
    if (octets.length === 4 && octets.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
      const high = ((octets[0] << 8) | octets[1]).toString(16);
      const low = ((octets[2] << 8) | octets[3]).toString(16);
      input = `${input.slice(0, lastColon + 1)}${high}:${low}`;
    }
  }

  let groups: string[];
  const doubleColon = input.indexOf('::');
  if (doubleColon !== -1) {
    const head = input.slice(0, doubleColon);
    const rest = input.slice(doubleColon + 2);
    const headGroups = head === '' ? [] : head.split(':');
    const tailGroups = rest === '' ? [] : rest.split(':');
    const missing = Math.max(8 - (headGroups.length + tailGroups.length), 0);
    groups = [...headGroups, ...Array<string>(missing).fill('0'), ...tailGroups];
  } else {
    groups = input.split(':');
  }

  groups = groups.map((group) => {
    const withoutLeadingZeros = group.replace(/^0+/, '');
    return withoutLeadingZeros === '' ? '0' : withoutLeadingZeros;
  });

  let bestStart = -1;
  let bestLength = 0;
  let runStart = -1;
  let runLength = 0;
  for (let i = 0; i < groups.length; i += 1) {
    if (groups[i] === '0') {
      if (runStart === -1) {
        runStart = i;
      }
      runLength += 1;
      if (runLength > bestLength) {
        bestLength = runLength;
        bestStart = runStart;
      }
    } else {
      runStart = -1;
      runLength = 0;
    }
  }

  if (bestLength < 2) {
    return groups.join(':');
  }

  const compressedHead = groups.slice(0, bestStart).join(':');
  const compressedTail = groups.slice(bestStart + bestLength).join(':');
  return `${compressedHead}::${compressedTail}`;
}
