import type {DetectionResult} from '../archive/detectors/types'; import type {NormalizedArchiveData} from '../archive/schemas/models';
export type ImportRequest={action:'inspect'|'import';file:File};
export type ImportProgress={type:'progress';stage:'opening'|'inspecting'|'detected'|'profile'|'posts'|'messages'|'media'|'search'|'complete';message:string;completed?:number;total?:number}|{type:'result';result:DetectionResult}|{type:'import-result';data:NormalizedArchiveData}|{type:'error';message:string};
