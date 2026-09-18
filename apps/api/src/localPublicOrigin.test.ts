import { describe, expect, it } from "vitest";
import { allowsLocalPublicOrigin } from "./localPublicOrigin";

describe("local public origin access", () => {
  it("allows loopback public origins only when the API is also loopback", () => {
    expect(
      allowsLocalPublicOrigin(
        "http://localhost:8080/v1/handoff",
        "http://localhost:4321",
      ),
    ).toBe(true);
    expect(
      allowsLocalPublicOrigin(
        "http://127.0.0.1:8080/v1/public/sites/demo-wedding/mural",
        "http://[::1]:4321",
      ),
    ).toBe(true);
  });

  it("does not open loopback origins on deployed APIs", () => {
    expect(
      allowsLocalPublicOrigin(
        "https://api.example.test/v1/handoff",
        "http://localhost:4321",
      ),
    ).toBe(false);
    expect(
      allowsLocalPublicOrigin(
        "http://localhost:8080/v1/handoff",
        "https://demo.entrelacos.workers.dev",
      ),
    ).toBe(false);
    expect(allowsLocalPublicOrigin("http://localhost:8080/v1/handoff")).toBe(
      false,
    );
  });
});
