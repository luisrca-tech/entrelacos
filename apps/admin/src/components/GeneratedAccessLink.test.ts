import { expect, it } from "vitest";
import { accessLinkMailto } from "./GeneratedAccessLink";

it("keeps the recipient readable and encodes only the message fields", () => {
  const href = accessLinkMailto(
    "Ana Souza",
    "ana+casal@example.test",
    "https://painel.example.test/ativar#token=abc&x=1",
  );
  expect(href.startsWith("mailto:ana%2Bcasal@example.test?subject=")).toBe(
    true,
  );
  const query = new URLSearchParams(href.slice(href.indexOf("?") + 1));
  expect(query.get("subject")).toBe("Seu acesso ao painel Entrelaços");
  expect(query.get("body")).toContain(
    "https://painel.example.test/ativar#token=abc&x=1",
  );
  expect(href).not.toContain("#");
  expect(href).toContain("%23token%3Dabc%26x%3D1");
});
