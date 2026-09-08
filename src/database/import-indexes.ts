/** Only browsing indexes are deferred. Primary keys (deduplication) and
 * archive-part indexes (provenance/retry) remain active throughout import. */
export const MESSAGE_BROWSING_INDEXES: Record<string, string> = {
  idx_messages_conversation_sent: 'messages(conversation_id,sent_at)',
  idx_messages_sender: 'messages(sender_name)',
  idx_messages_sender_id: 'messages(sender_id)',
  idx_messages_conversation_sent_id: 'messages(conversation_id,sent_at DESC,id DESC)',
  idx_messages_sent_id: 'messages(sent_at DESC,id DESC)',
};
export const DERIVED_SEARCH_INDEXES: Record<string, string> = {
  idx_search_documents_type: 'search_documents(entity_type)',
  idx_search_documents_created_id: 'search_documents(created_at DESC,entity_id ASC)',
};
export function deferBrowsingIndexes(exec: (sql: string) => unknown) {
  for (const name of Object.keys(MESSAGE_BROWSING_INDEXES)) exec(`DROP INDEX IF EXISTS ${name}`);
}
export function deferDerivedSearchIndexes(exec: (sql: string) => unknown) {
  for (const name of Object.keys(DERIVED_SEARCH_INDEXES)) exec(`DROP INDEX IF EXISTS ${name}`);
}
export function restoreDerivedSearchIndexes(exec: (sql: string) => unknown) {
  for (const [name, definition] of Object.entries(DERIVED_SEARCH_INDEXES)) exec(`CREATE INDEX IF NOT EXISTS ${name} ON ${definition}`);
}
