import type { AgentKind } from "./types.js";

export type ProviderFailure = {
  code: "PROVIDER_AUTHENTICATION_REQUIRED" | "PROVIDER_CONNECTION_FAILED";
  message: string;
  retryable: boolean;
};

const CLAUDE_AUTH_MESSAGE =
  "Claude OAuth credentials have expired or are invalid. Contact the system administrator to sign in to Claude again.";
const CLAUDE_CONNECTION_MESSAGE =
  "Claude is temporarily unreachable because of a network or provider outage. Please retry.";

export function classifyProviderFailure(params: {
  agent: AgentKind;
  code?: string;
  message: string;
  retryable?: boolean;
}): ProviderFailure | null {
  const code = params.code?.trim().toUpperCase() ?? "";
  const message = params.message.trim();
  if (params.agent === "claude") {
    const structuredAuth =
      /^(?:401|403|AUTH(?:ENTICATION)?(?:_ERROR|_FAILED|_REQUIRED)?|OAUTH(?:_ERROR|_EXPIRED|_INVALID)?|UNAUTHENTICATED|UNAUTHORIZED|TOKEN_(?:EXPIRED|INVALID|REVOKED)|CREDENTIALS?_(?:EXPIRED|INVALID|REVOKED))$/u.test(
        code
      );
    const signalledAuth =
      /(?:oauth|access token|refresh token|credentials?).{0,80}(?:expired|invalid|revoked|missing|login|log in|authenticate|authentication required)|(?:expired|invalid|revoked|missing).{0,80}(?:oauth|access token|refresh token|credentials?)|(?:not logged in|not authenticated|authentication required|please (?:run|use).{0,40}(?:login|log in)|unauthorized|\b(?:http\s*)?(?:401|403)\b)/iu.test(
        message
      );
    if (structuredAuth || signalledAuth) {
      return {
        code: "PROVIDER_AUTHENTICATION_REQUIRED",
        message: CLAUDE_AUTH_MESSAGE,
        retryable: false
      };
    }
  }

  const structuredConnection =
    /^(?:CONNECTION_(?:ERROR|FAILED|REFUSED|RESET|TIMEOUT)|NETWORK_(?:ERROR|UNREACHABLE)|ECONNREFUSED|ECONNRESET|ENETUNREACH|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|UPSTREAM_UNAVAILABLE)$/u.test(
      code
    );
  const signalledConnection =
    /(?:econnrefused|econnreset|enetunreach|enotfound|etimedout|eai_again|socket hang up|connection (?:refused|reset|timed out)|network (?:error|unreachable)|fetch failed|upstream (?:unavailable|connection)|tls handshake)/iu.test(
      message
    );
  if (structuredConnection || signalledConnection) {
    return {
      code: "PROVIDER_CONNECTION_FAILED",
      message: params.agent === "claude" ? CLAUDE_CONNECTION_MESSAGE : "The model provider is temporarily unreachable. Please retry.",
      retryable: true
    };
  }
  return null;
}
