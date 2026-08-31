import {create} from 'zustand'; import type {DetectionResult} from '../archive/detectors/types';
type State={fileName?:string;fileSize?:number;result?:DetectionResult;setArchive:(f:File,r:DetectionResult)=>void;clear:()=>void};
export const useArchiveStore=create<State>(set=>({setArchive:(f,r)=>set({fileName:f.name,fileSize:f.size,result:r}),clear:()=>set({fileName:undefined,fileSize:undefined,result:undefined})}));
