// @vitest-environment jsdom
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  PageHeaderActions,
  PageHeaderActionsProvider,
  PageHeaderActionsSlot,
} from "./PageHeaderActions";

let container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div");
  document.body.append(container);
});
afterEach(() => {
  container.remove();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: false });
});

it("renders actions in place when no page header hosts them", () => {
  const html = renderToStaticMarkup(
    createElement(
      PageHeaderActions,
      null,
      createElement("button", { type: "button" }, "Novo convite"),
    ),
  );
  expect(html).toContain(">Novo convite</button>");
});

it("moves actions into the page header slot and keeps their state", async () => {
  function Section() {
    const [count, setCount] = useState(0);
    return createElement(
      "section",
      { "data-testid": "section" },
      createElement("p", null, `Abertos ${count}`),
      createElement(
        PageHeaderActions,
        null,
        createElement(
          "button",
          { type: "button", onClick: () => setCount((value) => value + 1) },
          "Novo convite",
        ),
      ),
    );
  }
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(
        PageHeaderActionsProvider,
        null,
        createElement(
          "header",
          null,
          createElement("h1", null, "Convites"),
          createElement(PageHeaderActionsSlot, { className: "actions" }),
        ),
        createElement(Section),
      ),
    );
  });
  const slot = container.querySelector("header .actions");
  const button = slot?.querySelector("button");
  expect(button?.textContent).toBe("Novo convite");
  expect(container.querySelector("section button")).toBeNull();
  await act(async () => button?.click());
  expect(container.querySelector("section p")?.textContent).toBe("Abertos 1");
  await act(async () => root.unmount());
});

it("hides an empty slot so the header does not reserve space", async () => {
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(
        PageHeaderActionsProvider,
        null,
        createElement(PageHeaderActionsSlot, { className: "actions" }),
      ),
    );
  });
  expect(container.querySelector(".actions")?.className).toContain(
    "empty:hidden",
  );
  await act(async () => root.unmount());
});
