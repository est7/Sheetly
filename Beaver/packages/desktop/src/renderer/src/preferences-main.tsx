import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Preferences } from './Preferences';
import './styles.css';

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <Preferences />
  </StrictMode>
);
