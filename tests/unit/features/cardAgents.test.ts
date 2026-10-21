import { describe, expect, it } from 'vitest';
import { cardAgents, type CardChat } from '../../../src/features/backlog/cardAgents';
import type { ReviewState } from '../../../src/features/backlog/review';

const chat = (name: string, state: CardChat['state'], item = 'BL-1'): CardChat => ({ state, agent: { name, item } });
const review = (r: Partial<ReviewState>): ReviewState => ({ state: 'working', round: 0, ...r }) as ReviewState;

describe('cardAgents', () => {
  it('shows a working agent', () => {
    expect(cardAgents({ id: 'BL-1' }, [chat('Nova-7', 'working')])).toEqual([{ name: 'Nova-7', state: 'working' }]);
  });

  it('shows an agent waiting for input, in its chat or by asking in the ticket', () => {
    expect(cardAgents({ id: 'BL-1' }, [chat('Nova-7', 'waiting-for-input')])).toEqual([{ name: 'Nova-7', state: 'waiting' }]);
    expect(cardAgents({ id: 'BL-1', review: review({ state: 'asking', implementer: 'Nova-7' }) }, [])).toEqual([{ name: 'Nova-7', state: 'waiting' }]);
  });

  it('shows a paused agent, over a chat that still reads as working', () => {
    const r = review({ state: 'paused', paused: { phase: 'work', session: 's', agent: 'Nova-7', resume: 'working' } });
    expect(cardAgents({ id: 'BL-1', review: r }, [chat('Nova-7', 'working')])).toEqual([{ name: 'Nova-7', state: 'paused' }]);
  });

  it('shows each of several agents once, the most pressing state of each', () => {
    const chats = [chat('Nova-7', 'working'), chat('Byte-2', 'working'), chat('Nova-7', 'waiting-for-input')];
    expect(cardAgents({ id: 'BL-1' }, chats)).toEqual([
      { name: 'Nova-7', state: 'waiting' },
      { name: 'Byte-2', state: 'working' },
    ]);
  });

  it('shows none without agents: ended chats, other tickets, chats of no agent', () => {
    expect(cardAgents({ id: 'BL-1' }, [])).toEqual([]);
    expect(cardAgents({ id: 'BL-1' }, [chat('Nova-7', 'done'), chat('Byte-2', 'ended'), chat('Dex-8', 'working', 'BL-2'), { state: 'working' }])).toEqual([]);
  });
});
