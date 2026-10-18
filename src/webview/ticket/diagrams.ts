import type mermaidApi from 'mermaid';

/**
 * Mermaid diagrams in a ticket (BL-79): a ```mermaid block renders as a diagram. Mermaid is a bundle of its own
 * (dist/mermaid.js, its address on #root's data-mermaid), loaded once, the first time a ticket has a diagram.
 */
type Mermaid = typeof mermaidApi;

// The page's script nonce, which the Mermaid script needs too (read while this script runs: it's gone after).
const nonce = (document.currentScript as HTMLScriptElement | null)?.nonce;

let loading: Promise<Mermaid> | undefined;

function dark(): boolean {
  const c = document.body.classList;
  return c.contains('vscode-dark') || (c.contains('vscode-high-contrast') && !c.contains('vscode-high-contrast-light'));
}

function load(): Promise<Mermaid> {
  loading ??= new Promise<Mermaid>((resolve, reject) => {
    const src = document.getElementById('root')?.dataset.mermaid;
    if (!src) return reject(new Error('Mermaid is missing.'));
    const script = document.createElement('script');
    script.src = src;
    if (nonce) script.nonce = nonce;
    script.onload = () => {
      const mermaid = (window as unknown as { flotillaMermaid: Mermaid }).flotillaMermaid;
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark() ? 'dark' : 'default' });
      resolve(mermaid);
    };
    script.onerror = () => reject(new Error("Mermaid didn't load."));
    document.head.appendChild(script);
  }).catch((e: unknown) => {
    loading = undefined;
    throw e;
  });
  return loading;
}

/** The Mermaid blocks in rendered Markdown not drawn yet: VS Code's renderer, or a Markdown extension's (pre.mermaid). */
export function mermaidBlocks(root: Element): Element[] {
  return [...root.querySelectorAll('pre > code.language-mermaid, pre.mermaid, div.mermaid')]
    .map((el) => (el.tagName === 'CODE' ? el.parentElement! : el))
    .filter((el) => !el.closest('[data-diagram]'));
}

let next = 0;
// Mermaid draws one diagram at a time.
let queue: Promise<unknown> = Promise.resolve();

/** Draws the Mermaid blocks in root; a block that can't be drawn stays as code, with a note saying why. */
export function drawDiagrams(root: Element): Promise<void> {
  const blocks = mermaidBlocks(root);
  if (!blocks.length) return Promise.resolve();
  for (const block of blocks) block.setAttribute('data-diagram', '');
  const done = queue.then(async () => {
    let mermaid: Mermaid;
    try {
      mermaid = await load();
    } catch (e) {
      for (const block of blocks) block.after(note(e));
      return;
    }
    for (const block of blocks) {
      const id = `flotilla-diagram-${next++}`;
      try {
        const { svg } = await mermaid.render(id, block.textContent ?? '');
        const diagram = document.createElement('div');
        diagram.className = 'diagram';
        diagram.setAttribute('data-diagram', '');
        diagram.innerHTML = svg;
        block.replaceWith(diagram);
      } catch (e) {
        // Mermaid may leave its error drawing in the page.
        document.getElementById(`d${id}`)?.remove();
        document.getElementById(id)?.remove();
        block.after(note(e));
      }
    }
  });
  queue = done.catch(() => undefined);
  return done;
}

function note(e: unknown): HTMLElement {
  const el = document.createElement('div');
  el.className = 'media-note';
  el.textContent = `This diagram can't be drawn: ${e instanceof Error ? e.message : String(e)}`;
  return el;
}
