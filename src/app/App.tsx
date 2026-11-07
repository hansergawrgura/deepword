import { AppProvider } from '@/app/store';
import { ErrorBoundary } from '@/ui/ErrorBoundary';
import { Shell } from './Shell';
import './App.css';

export default function App() {
  return (
    <ErrorBoundary>
      <AppProvider>
        <Shell />
      </AppProvider>
    </ErrorBoundary>
  );
}
