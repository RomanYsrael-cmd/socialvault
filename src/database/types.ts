import type{Conversation,Media,Message,NormalizedArchiveData,Post,Profile}from'../archive/schemas/models';
export type StorageMode='opfs'|'indexeddb';export type SearchBackend='fts5'|'like';
export interface Page<T>{items:T[];nextCursor?:string;hasMore:boolean}
export interface ConversationPreview extends Conversation{messageCount:number;latestText?:string;latestSentAt?:string;isGroup:boolean}
export interface SearchResult{entityType:string;entityId:string;title?:string;body?:string;context?:string;createdAt?:string;conversationId?:string;sourcePath?:string}
export interface SearchResponse{items:SearchResult[];counts:Record<string,number>;hasMore:boolean;nextCursor?:string;backend:SearchBackend}
export interface ArchiveStats{profiles:number;posts:number;conversations:number;messages:number;media:number;earliest?:string;latest?:string;warnings:number;sections:number;years:number[]}
export type DatabaseRequest={id:number;type:'init'|'replace'|'profile'|'posts'|'conversations'|'messages'|'search'|'stats'|'media';data?:NormalizedArchiveData;conversationId?:string;cursor?:string;limit?:number;sort?:'newest'|'oldest';year?:number;query?:string};
export type DatabaseResult=Profile|Post[]|ConversationPreview[]|Message[]|Media[]|Page<Post>|Page<ConversationPreview>|Page<Message>|Page<Media>|SearchResponse|ArchiveStats|{mode:StorageMode;searchBackend:SearchBackend}|undefined;
export type DatabaseResponse={id:number;ok:true;data?:DatabaseResult}|{id:number;ok:false;error:string};
