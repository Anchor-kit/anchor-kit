/** SEP-24 interactive initiation response. */
export interface InteractiveInitiationResponse {
  type: 'interactive_customer_info_needed';
  url: string;
  id: string;
}

/** Adapt an already-authorized host URL and its transaction ID to the SEP-24 wire shape. */
export function createInteractiveInitiationResponse(input: {
  id: string;
  url: string;
}): InteractiveInitiationResponse {
  if (!input.id.trim()) throw new TypeError('Transaction ID must not be empty');
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    throw new TypeError('Interactive URL must be an absolute HTTPS URL');
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new TypeError('Interactive URL must be an absolute HTTPS URL without credentials');
  }
  return { type: 'interactive_customer_info_needed', url: input.url, id: input.id };
}
