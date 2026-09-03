import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import './clean-ui.css';
import './pop-ui.css';
import './refinement-ui.css';

createRoot(document.getElementById('root')).render(<React.StrictMode><App /></React.StrictMode>);
