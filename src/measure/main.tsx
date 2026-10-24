import '../no-devtools'
import { createRoot } from 'react-dom/client'
import { Measure } from './Measure'
import '../app.css'

createRoot(document.getElementById('root')!).render(<Measure />)
