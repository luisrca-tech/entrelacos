declare const __APP_ENV__: string | undefined;

export function showSandboxNotice(mode: string | null | undefined): boolean {
  return (
    typeof __APP_ENV__ !== "undefined" &&
    __APP_ENV__ === "development" &&
    mode === "sandbox"
  );
}
