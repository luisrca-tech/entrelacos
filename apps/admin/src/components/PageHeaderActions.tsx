import {
  createContext,
  type ReactNode,
  useContext,
  useMemo,
  useState,
} from "react";
import { createPortal } from "react-dom";

type SlotContext = {
  node: HTMLElement | null;
  setNode: (node: HTMLElement | null) => void;
};

// `undefined` means no page header hosts actions (standalone sections, tests);
// a context with a null node means the header slot is not mounted yet.
const PageHeaderActionsContext = createContext<SlotContext | undefined>(
  undefined,
);

export function PageHeaderActionsProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [node, setNode] = useState<HTMLElement | null>(null);
  const value = useMemo(() => ({ node, setNode }), [node]);
  return (
    <PageHeaderActionsContext.Provider value={value}>
      {children}
    </PageHeaderActionsContext.Provider>
  );
}

/** Where the page header shows the actions a section registers. */
export function PageHeaderActionsSlot({ className }: { className?: string }) {
  const context = useContext(PageHeaderActionsContext);
  return (
    <div
      ref={context?.setNode}
      className={`${className ?? ""} empty:hidden`.trim()}
    />
  );
}

/**
 * Renders a section's primary actions beside the page title. The actions stay
 * owned by the section (state, handlers, dialogs); only their DOM moves.
 */
export function PageHeaderActions({ children }: { children: ReactNode }) {
  const context = useContext(PageHeaderActionsContext);
  if (context === undefined) return <>{children}</>;
  return context.node ? createPortal(children, context.node) : null;
}
