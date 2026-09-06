import type{Conversation,Media,Message,NormalizedArchiveData,Person,Post,Profile,ArchiveIdentity}from'../archive/schemas/models';
export type StorageMode='opfs'|'indexeddb';export type SearchBackend='fts5'|'like';
export interface Page<T>{items:T[];nextCursor?:string;hasMore:boolean}
export interface ConversationPreview extends Conversation{messageCount:number;latestText?:string;latestSentAt?:string;isGroup:boolean}
export interface PersonSummary extends Person{participationCount:number;messageCount:number;postCount:number;mediaCount:number;firstInteraction?:string;lastInteraction?:string}
export interface SearchResult{entityType:string;entityId:string;title?:string;body?:string;context?:string;snippet?:string;createdAt?:string;conversationId?:string;sourcePath?:string}
export interface SearchResponse{items:SearchResult[];counts:Record<string,number>;hasMore:boolean;nextCursor?:string;backend:SearchBackend}
export interface ArchiveStats{profiles:number;people:number;posts:number;conversations:number;messages:number;media:number;earliest?:string;latest?:string;warnings:number;sections:number;years:number[];diagnostics?:NormalizedArchiveData['diagnostics'];archiveIdentity?:ArchiveIdentity}
export type DatabaseRequest={id:number;type:'init'|'replace'|'profile'|'people'|'person'|'posts'|'conversations'|'messages'|'search'|'stats'|'media'|'archive-identity'|'media-cache';data?:NormalizedArchiveData;conversationId?:string;personId?:string;cursor?:string;limit?:number;sort?:'newest'|'oldest';year?:number;query?:string;mediaType?:Media['mediaType'];mediaPath?:string;byteSize?:number};
export type DatabaseResult=Profile|PersonSummary|PersonSummary[]|Post[]|ConversationPreview[]|Message[]|Media[]|Page<Post>|Page<PersonSummary>|Page<ConversationPreview>|Page<Message>|Page<Media>|SearchResponse|ArchiveStats|ArchiveIdentity|{mode:StorageMode;searchBackend:SearchBackend}|undefined;
export type DatabaseResponse={id:number;ok:true;data?:DatabaseResult}|{id:number;ok:false;error:string};
