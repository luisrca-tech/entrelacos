export function isLocalGiftPreview(development: boolean, url: URL): boolean {
  return (
    development && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
  );
}
