import type {Archive} from '../schemas/models'; import type {DetectionResult} from '../detectors/types';
export function createFacebookArchive(result:DetectionResult):Archive{return {id:crypto.randomUUID(),platform:result.platform}}
