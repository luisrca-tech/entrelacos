import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(import.meta.dirname, "routes/login.tsx"),
  "utf8",
);

describe("login form fallback safety", () => {
  it("cannot submit credentials through a pre-hydration GET request", () => {
    expect(source).toContain('method="post"');
    expect(source).toContain("const [hydrated, setHydrated] = useState(false)");
    expect(source).toContain(
      'data-login-ready={hydrated ? "true" : undefined}',
    );
    expect(source).toContain("disabled={!hydrated || pending}");
  });

  it("keeps the login page heading as a document-level h1", () => {
    expect(source.match(/<h1\b/g)).toHaveLength(1);
  });
});
