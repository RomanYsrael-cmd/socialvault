import type {ArchiveDetector,ArchiveEntryInfo,DetectionResult} from './types';

type Marker={needle:string;section:string;supported:boolean};
/** Directory hints seen in Facebook Download Your Information exports. */
const markers:Marker[]=[
  {needle:'profile_information',section:'Profile',supported:true},{needle:'profile_v2',section:'Profile',supported:true},{needle:'personal_information',section:'Profile',supported:true},{needle:'/profile/',section:'Profile',supported:true},{needle:'/profile.json',section:'Profile',supported:true},{needle:'your_posts',section:'Posts',supported:true},{needle:'/posts/',section:'Posts',supported:true},
  {needle:'messages/',section:'Messages',supported:true},{needle:'/messages/',section:'Messages',supported:true},{needle:'archived_threads',section:'Messages',supported:true},{needle:'filtered_messages',section:'Messages',supported:true},{needle:'message_requests',section:'Messages',supported:true},{needle:'marketplace_messages',section:'Messages',supported:true},
  {needle:'comments',section:'Comments',supported:true},{needle:'reactions',section:'Reactions',supported:true},{needle:'likes_and_reactions',section:'Reactions',supported:true},{needle:'friends',section:'Friends',supported:true},{needle:'followers',section:'Friends',supported:true},{needle:'following',section:'Friends',supported:true},{needle:'friend_requests',section:'Friends',supported:true},{needle:'connections',section:'Friends',supported:true},{needle:'albums',section:'Albums',supported:true},{needle:'/album/',section:'Albums',supported:true},{needle:'your_photos',section:'Photos',supported:true},{needle:'your_videos',section:'Photos',supported:true},{needle:'photos_and_videos',section:'Photos',supported:false},
  {needle:'your_activity_across_facebook',section:'Activity',supported:false},{needle:'saved_items',section:'Saved items',supported:false},{needle:'saved',section:'Saved items',supported:false},{needle:'search_history',section:'Search history',supported:false},{needle:'searches',section:'Search history',supported:false},{needle:'groups',section:'Groups',supported:false},{needle:'events',section:'Events',supported:false},{needle:'location_history',section:'Location history',supported:false},{needle:'ads',section:'Ads',supported:false},{needle:'security',section:'Security',supported:false},{needle:'payments',section:'Payments',supported:false}
];

// Facebook HTML exports can be split across a structural ZIP and several
// media-only ZIPs.  A media-only part is safe to retain as a connected source
// only when every file is a media asset under a Facebook export root.  Keep
// this deliberately strict so an arbitrary collection of images is still
// rejected by the archive detector.
const mediaExtension= /\.(?:jpe?g|png|gif|webp|heic|mp4|mov|m4v|avi|mkv|mp3|m4a|wav|ogg|pdf)$/i;
const facebookMediaRoot= (path:string) => /^(?:your_facebook_activity|personal_information|messages|connections|facebook)\//i.test(path);

export const facebookSectionForPath=(filename:string)=>{
  const path=filename.toLowerCase().replaceAll('\\','/');
  const found=markers.filter(marker=>path.includes(marker.needle));
  return found.length?found[0]:undefined;
};

export const facebookDetector:ArchiveDetector={platform:'facebook',detect(entries:ArchiveEntryInfo[]):DetectionResult{
  const paths=entries.map(e=>e.filename.toLowerCase().replaceAll('\\','/'));
  const jsonCount=paths.filter(p=>p.endsWith('.json')).length;
  const htmlCount=paths.filter(p=>p.endsWith('.html')||p.endsWith('.htm')).length;
  const format=jsonCount>0&&htmlCount>0?'mixed':jsonCount>0?'json':htmlCount>0?'html':'unknown';
  const found=markers.filter(marker=>paths.some(path=>path.includes(marker.needle)));
  const sections=[...new Set(found.map(marker=>marker.section))];
  const supportedSections=[...new Set(found.filter(marker=>marker.supported).map(marker=>marker.section))];
  const unsupportedSections=[...new Set(found.filter(marker=>!marker.supported).map(marker=>marker.section))];
  const identity=paths.some(p=>p.includes('profile_information/profile_information.json')||p.includes('profile_v2/profile_v2.json')||p.endsWith('/profile_information.json')||p.endsWith('/profile_v2.json')||p.endsWith('/personal_information.json')||p.endsWith('/profile.json')||p==='profile_information.json'||p==='profile_v2.json'||p==='profile.json');
  const structure=paths.some(p=>p.startsWith('your_facebook_activity/')||p.startsWith('personal_information/')||p.startsWith('messages/')||p.startsWith('facebook/'))||sections.length>=2;
  // HTML exports are supported when they contain the structural cards used by
  // Facebook's Download Your Information renderer.  A random HTML page that
  // merely happens to contain a Facebook-looking filename remains rejected.
  const htmlStructure = htmlCount > 0 && sections.length > 0 && paths.some(path => path.startsWith('your_facebook_activity/') || path.startsWith('personal_information/') || path.startsWith('profile_information/') || path.startsWith('profile_v2/') || path.startsWith('messages/') || path.startsWith('connections/') || path.startsWith('facebook/'));
  const supported=(jsonCount>0 || htmlStructure)&&(identity||structure||sections.length>0);
  const mediaOnlyEligible = format === 'unknown' && paths.some(path => path && !path.endsWith('/')) && paths.filter(path => !path.endsWith('/')).every(path => facebookMediaRoot(path) && mediaExtension.test(path));
  const warnings:string[]=[];
  if(supported&&supportedSections.length<2)warnings.push('Only a limited set of recognizable Facebook sections was found.');
  if(format==='html'&&sections.length&&!supported)warnings.push('Facebook HTML export markers were found, but no supported structural HTML file was detected.');
  if(format==='html'&&supported)warnings.push('Facebook HTML export detected. Supported HTML sections will be parsed locally; unsupported pages are skipped with warnings.');
  if(format==='mixed')warnings.push('This archive contains both JSON and HTML Facebook export files. JSON is preferred where a section has JSON coverage; supported HTML pages fill gaps.');
  if(unsupportedSections.length)warnings.push(`Detected unsupported Facebook sections: ${unsupportedSections.join(', ')}.`);
  const confidence=supported?Math.min(.98,.55+sections.length*.06):((format==='html'&&sections.length>0) ? .2 : .05);
  return {metadataOnlyEligible: mediaOnlyEligible, supported,platform:supported?'facebook':'unknown',confidence,entryCount:entries.length,inspectedEntries:entries.length,sections,supportedSections,unsupportedSections,warnings,format};
}};
