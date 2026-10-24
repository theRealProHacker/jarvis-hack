import '../no-devtools'
import { createRoot } from 'react-dom/client'
import '../app.css'
import './demo.css'
import { Demo } from './Demo'

createRoot(document.getElementById('root')!).render(<Demo />)
