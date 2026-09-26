import { Toaster } from "@entrelacos/ui";
import {
  createRootRoute,
  HeadContent,
  Outlet,
  Scripts,
} from "@tanstack/react-router";
import type { ReactNode } from "react";

import "../tailwind.css";

export const Route = createRootRoute({
  head: () => ({
    links: [{ rel: "icon", href: "/brand/entrelacos-favicon.svg" }],
    meta: [
      { charSet: "utf-8" },
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1",
      },
      { title: "EntreLaços — Painel" },
    ],
  }),
  component: RootComponent,
});

function RootComponent() {
  return (
    <RootDocument>
      <Outlet />
    </RootDocument>
  );
}

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="pt-BR">
      <head>
        <HeadContent />
      </head>
      <body className="min-w-[320px] min-h-screen bg-admin-canvas text-admin-ink font-sans antialiased [font-synthesis:none] [text-rendering:optimizeLegibility] [&_a:focus-visible]:border-admin-terracotta [&_a:focus-visible]:outline-[3px] [&_a:focus-visible]:outline-[rgb(168_77_57_/_20%)] [&_a:focus-visible]:outline-offset-2 [&_button]:cursor-pointer [&_button:disabled]:cursor-wait [&_button:focus-visible]:border-admin-terracotta [&_button:focus-visible]:outline-[3px] [&_button:focus-visible]:outline-[rgb(168_77_57_/_20%)] [&_button:focus-visible]:outline-offset-2 [&_button:focus-visible]:ring-0 [&_h3]:m-0 [&_h3]:font-admin-display [&_h3]:text-[1.55rem] [&_h3]:font-normal [&_h3]:leading-[1.08] [&_h3]:tracking-[-0.025em]">
        {children}
        <Toaster />
        <Scripts />
      </body>
    </html>
  );
}
