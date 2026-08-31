import type {DetectionResult} from '../archive/detectors/types';
export type ImportProgress={type:'progress';stage:'opening'|'inspecting'|'detected';message:string}|{type:'result';result:DetectionResult}|{type:'error';message:string};
