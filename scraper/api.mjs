// Volania interného API Workera (spoločné pre kontrolu cien aj kanárika).
export function createApi(apiUrl, token) {
  return async function api(path, options = {}) {
    const res = await fetch(new URL(path, apiUrl), {
      ...options,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    if (!res.ok) throw new Error(`API ${path} vrátilo HTTP ${res.status}: ${await res.text()}`);
    return res.json();
  };
}
