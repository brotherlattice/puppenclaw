import { describe, expect, it } from "vitest";

import { classifyProviderFailure } from "../../src/shared/provider-failures.js";

describe("provider failure classification", () => {
  it("recognizes narrow Claude authentication and connection failures", () => {
    expect(
      classifyProviderFailure({
        agent: "claude",
        code: "AUTHENTICATION_ERROR",
        message: "OAuth access token expired"
      })
    ).toMatchObject({ code: "PROVIDER_AUTHENTICATION_REQUIRED", retryable: false });
    expect(
      classifyProviderFailure({
        agent: "claude",
        message: "request failed with HTTP 401"
      })
    ).toMatchObject({ code: "PROVIDER_AUTHENTICATION_REQUIRED", retryable: false });
    expect(
      classifyProviderFailure({
        agent: "claude",
        code: "ECONNRESET",
        message: "socket closed"
      })
    ).toMatchObject({ code: "PROVIDER_CONNECTION_FAILED", retryable: true });
  });

  it("does not turn permission, rate-limit, or non-Claude auth failures into Claude OAuth expiry", () => {
    expect(
      classifyProviderFailure({
        agent: "claude",
        code: "PERMISSION_DENIED",
        message: "permission denied for this tool"
      })
    ).toBeNull();
    expect(
      classifyProviderFailure({
        agent: "claude",
        code: "RATE_LIMITED",
        message: "rate limit exceeded",
        retryable: true
      })
    ).toBeNull();
    expect(
      classifyProviderFailure({
        agent: "codex",
        code: "401",
        message: "HTTP 401"
      })
    ).toBeNull();
  });
});
