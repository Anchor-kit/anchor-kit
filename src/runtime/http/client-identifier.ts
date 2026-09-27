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
  if (typeof forwardedFor === 'string') {
    return extractLeftMostAddress(forwardedFor);
  }

  if (Array.isArray(forwardedFor) && typeof forwardedFor[0] === 'string') {
    return extractLeftMostAddress(forwardedFor[0]);
  }

  return null;
}

function extractLeftMostAddress(value: string): string | null {
  const leftMost = value.split(',')[0]?.trim();
  return leftMost ? leftMost : null;
}
