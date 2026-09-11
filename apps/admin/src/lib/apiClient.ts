export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(
      status === 401
        ? "Sua sessão expirou ou não está autenticada. Entre novamente."
        : status === 403
          ? "Acesso negado."
          : status === 404
            ? "Registro não encontrado."
            : status === 409
              ? "A operação conflita com o estado atual. Atualize a página e tente novamente."
              : status === 400
                ? "Confira os dados. O link pode estar inválido, expirado ou já ter sido usado."
                : "Não foi possível concluir. Tente novamente.",
    );
  }
}

export async function apiRequest<T>(
  path: string,
  options: { method?: string; body?: unknown } = {},
  fetcher: typeof fetch = fetch,
): Promise<T> {
  if (!path.startsWith("/v1/") || path.includes("..") || path.includes("\\"))
    throw new Error("Invalid API path");
  const response = await fetcher(`/api${path}`, {
    method: options.method ?? "GET",
    credentials: "same-origin",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    ...(options.body === undefined
      ? {}
      : { body: JSON.stringify(options.body) }),
  });
  if (!response.ok) {
    const problem = (await response.json().catch(() => ({}))) as {
      code?: string;
    };
    throw new ApiError(response.status, problem.code ?? "REQUEST_FAILED");
  }
  return response.json() as Promise<T>;
}

export function safePanelReturn(value: unknown): string {
  if (typeof value !== "string") return "/";
  if (
    value.startsWith("/handoff?") &&
    !value.includes("#") &&
    !value.includes("\\")
  )
    return value;
  return "/";
}
