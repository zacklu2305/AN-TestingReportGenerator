import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import {applyDesignSystem} from './designSystem.ts';
import './index.css';

applyDesignSystem();

createRoot(document.getElementById('root')!).render(<App />);
