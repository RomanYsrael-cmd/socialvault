import type {ArchiveDetector,ArchiveEntryInfo,DetectionResult} from './types';

type Marker={needle:string;section:string;supported:boolean};
/** Directory hints seen in Facebook Download Your Information exports. */
const markers:Marker[]=[
  {needle:'profile_information',section:'Profile',supported:true},{needle:'profile_v2',section:'Profile',supported:true},{needle:'personal_information',section:'Profile',supported:true},{needle:'/profile/',section:'Profile',supported:true},{needle:'/profile.json',section:'Profile',supported:true},{needle:'your_posts',section:'Posts',supported:true},{needle:'/posts/',section:'Posts',supported:true},
  {needle:'messages/',section:'Messages',supported:true},{needle:'/messages/',section:'Messages',supported:true},{needle:'archived_threads',section:'Messages',supported:true},{needle:'filtered_messages',section:'Messages',supported:true},{needle:'message_requests',section:'Messages',supported:true},{needle:'marketplace_messages',section:'Messages',supported:true},
  {needle:'comments',section:'Comments',supported:true},{needle:'reactions',section:'Reactions',supported:true},{needle:'likes_and_reactions',section:'Reactions',supported:true},{needle:'friends',section:'Friends',supported:true},{needle:'followers',section:'Friends',supported:true},{needle:'following',section:'Friends',supported:true},{needle:'friend_requests',section:'Friends',supported:true},{needle:'connections',section:'Friends',supported:true},{needle:'albums',section:'Albums',supported:true},{needle:'photos_and_videos',section:'Photos',supported:false},
  {needle:'your_activity_across_facebook',section:'Activity',supported:false},{needle:'saved_items',section:'Saved items',supported:false},{needle:'saved',section:'Saved items',supported:false},{needle:'search_history',section:'Search history',supported:false},{needle:'searches',section:'Search history',supported:false},{needle:'groups',section:'Groups',supported:false},{needle:'events',section:'Events',supported:false},{needle:'location_history',section:'Location history',supported:false},{needle:'ads',section:'Ads',supported:false},{needle:'security',section:'Security',supported:false},{needle:'payments',section:'Payments',supported:false}
];

export const facebookSectionForPath=(filename:string)=>{
  const path=filename.toLowerCase().replaceAll('\\','/');
  const found=markers.filter(marker=>path.includes(marker.needle));
  return found.length?found[0]:undefined;
};

export const facebookDetector:ArchiveDetector={platform:'facebook',detect(entries:ArchiveEntryInfo[]):DetectionResult{
  const paths=entries.map(e=>e.filename.toLowerCase().replaceAll('\\','/'));
  const jsonCount=paths.filter(p=>p.endsWith('.json')).length;
  const found=markers.filter(marker=>paths.some(path=>path.includes(marker.needle)));
  const sections=[...new Set(found.map(marker=>marker.section))];
  const supportedSections=[...new Set(found.filter(marker=>marker.supported).map(marker=>marker.section))];
  const unsupportedSections=[...new Set(found.filter(marker=>!marker.supported).map(marker=>marker.section))];
  const identity=paths.some(p=>p.includes('profile_information/profile_information.json')||p.includes('profile_v2/profile_v2.json')||p.endsWith('/profile_information.json')||p.endsWith('/profile_v2.json')||p.endsWith('/personal_information.json')||p.endsWith('/profile.json')||p==='profile_information.json'||p==='profile_v2.json'||p==='profile.json');
  const structure=paths.some(p=>p.startsWith('your_facebook_activity/')||p.startsWith('personal_information/')||p.startsWith('messages/')||p.startsWith('facebook/'))||sections.length>=2;
  const supported=jsonCount>0&&(identity||structure||sections.length>0);
  const warnings:string[]=[];
  if(supported&&supportedSections.length<2)warnings.push('Only a limited set of recognizable Facebook sections was found.');
  if(unsupportedSections.length)warnings.push(`Detected unsupported Facebook sections: ${unsupportedSections.join(', ')}.`);
  return {supported,platform:supported?'facebook':'unknown',confidence:supported?Math.min(.98,.55+sections.length*.06):.05,entryCount:entries.length,inspectedEntries:entries.length,sections,supportedSections,unsupportedSections,warnings};
}};
