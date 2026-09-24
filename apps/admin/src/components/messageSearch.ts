export function messagesQuery(search: string, cursor?: string): string {
  const query = new URLSearchParams({ limit: "20" });
  const authorName = search.trim();
  if (authorName) query.set("search", authorName);
  if (cursor) query.set("cursor", cursor);
  return query.toString();
}
