import { render } from 'preact';
// The shared rules first (after the CI list's and the priority picker's, as before): each part's own CSS, imported by
// its module, comes after them.
import './ci.css';
import './priority.css';
import './styles.css';
import { App } from './app';

render(<App />, document.getElementById('root')!);
