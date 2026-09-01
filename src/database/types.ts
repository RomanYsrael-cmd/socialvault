import type{Conversation,Message,NormalizedArchiveData,Post,Profile}from'../archive/schemas/models';
export type StorageMode='opfs'|'indexeddb';
export type DatabaseRequest={id:number;type:'init'|'replace'|'profile'|'posts'|'conversations'|'messages';data?:NormalizedArchiveData;conversationId?:string};
export type DatabaseResponse={id:number;ok:true;data?:Profile|Post[]|Conversation[]|Message[]|{mode:StorageMode}}|{id:number;ok:false;error:string};
