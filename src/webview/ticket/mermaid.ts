// Mermaid for the ticket view (BL-79), in a bundle of its own (dist/mermaid.js): it's big, so a ticket loads it only
// when it has a diagram (see diagrams.ts).
import mermaid from 'mermaid';

(window as unknown as { flotillaMermaid: typeof mermaid }).flotillaMermaid = mermaid;
