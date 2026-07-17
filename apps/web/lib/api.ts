const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

/**
 * Thin fetch wrapper for apps/api. Always sends credentials so the
 * httpOnly refresh cookie rides along, and normalizes error bodies (the
 * backend always replies `{ error, message }` on failure — see
 * apps/api/src/modules/auth/auth.routes.ts) into a typed ApiError.
 */
export async function apiFetch<T>(
  path: string,
  options: RequestInit & { accessToken?: string } = {},
): Promise<T> {
  const { accessToken, headers, ...rest } = options;

  const res = await fetch(`${API_URL}${path}`, {
    ...rest,
    credentials: "include",
    headers: {
      ...(rest.body ? { "content-type": "application/json" } : {}),
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      ...headers,
    },
  });

  const body = await res.json().catch(() => null);

  if (!res.ok) {
    throw new ApiError(body?.message ?? res.statusText, res.status);
  }

  return body as T;
}
