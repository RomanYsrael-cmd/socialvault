import { Navigate, Route, Routes } from 'react-router-dom';
import { LandingPage } from '../pages/LandingPage';
import { ArchiveOverview } from '../pages/ArchiveOverview';
import { PlaceholderPage } from '../pages/PlaceholderPage';
import { ProfilePage } from '../pages/ProfilePage';
import { PersonPage } from '../pages/PersonPage';
import { PeoplePage } from '../pages/PeoplePage';
import { PostsPage } from '../pages/PostsPage';
import { MessagesPage } from '../pages/MessagesPage';
import { ConversationPage } from '../pages/ConversationPage';
import { SearchPage } from '../pages/SearchPage';
import { MediaPage } from '../pages/MediaPage';
import { FriendsPage } from '../pages/FriendsPage';
import { AlbumsPage } from '../pages/AlbumsPage';
import { AlbumPage } from '../pages/AlbumPage';
import { Shell } from '../components/Shell';

export function App() {
  return <Routes><Route path="/" element={<LandingPage/>}/><Route element={<Shell/>}><Route path="/archive" element={<ArchiveOverview/>}/><Route path="/home" element={<PostsPage/>}/><Route path="/profile" element={<ProfilePage/>}/><Route path="/people" element={<PeoplePage/>}/><Route path="/people/:personId" element={<PersonPage/>}/><Route path="/friends" element={<FriendsPage/>}/><Route path="/messages" element={<MessagesPage/>}/><Route path="/messages/:conversationId" element={<ConversationPage/>}/><Route path="/albums" element={<AlbumsPage/>}/><Route path="/albums/:albumId" element={<AlbumPage/>}/><Route path="/search" element={<SearchPage/>}/><Route path="/photos" element={<MediaPage/>}/><Route path="/memories" element={<PlaceholderPage title="memories"/>}/></Route><Route path="*" element={<Navigate to="/" replace/>}/></Routes>;
}
