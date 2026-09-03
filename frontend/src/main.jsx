import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import './clean-ui.css';
import './pop-ui.css';
import './refinement-ui.css';
import './discovery-layout.css';
import './sitewide-hardening.css';

createRoot(document.getElementById('root')).render(<React.StrictMode><App /></React.StrictMode>);