/**
 * The write-tool confirmation gate, driven through the screen the owner uses:
 * tui/Chat.tsx → core/agent.ts → core/tools.ts describeToolCall().
 *
 * describeToolCall() throws for a write tool nobody has written a description
 * for, rather than asking the owner to approve a bare tool name. That is the
 * right answer at that layer and these tests keep it. What was wrong was the
 * call site: core/agent.ts called it bare while the assistant's message was
 * still streaming, so the throw escaped runAgentTurn and killed the whole turn —
 * Chat.tsx rolled the turn's history back and printed the exception. One tool
 * with no description took down every other tool in the same turn, the streamed
 * answer, and the conversation's memory of it.
 *
 * A refusal is not a crash. The tool must not run, the owner must be told in
 * words that the call could not be confirmed, and the conversation must keep
 * working — which is what these tests assert.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { render, cleanup } from 'ink-testing-library';

const { TEST_DATA_DIR } = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  return { TEST_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'fungible-agent-confirm-')) };
});

// Never the owner's real ~/.fungible: core/tools.ts resolves the canvas and
// screen-capture paths from DATA_DIR at import time.
vi.mock('../../core/paths.js', () => ({ DATA_DIR: TEST_DATA_DIR }));
vi.mock('../../core/db.js', async () => {
  const { makeTestDb } = await import('../helpers/makeTestDb.js');
  return { db: await makeTestDb() };
});

type Chunk =
  | { type: 'text'; delta: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };

/** One entry per streamResponse() call the agent loop is expected to make. */
const scriptedTurns: Chunk[][] = [];
/** The history the agent handed the provider on each call. */
const seenHistories: unknown[][] = [];

vi.mock('../../core/llm-provider.js', () => ({
  streamResponse: vi.fn(async function* (_system: string, history: unknown[]) {
    seenHistories.push(JSON.parse(JSON.stringify(history)) as unknown[]);
    for (const chunk of scriptedTurns.shift() ?? []) yield chunk;
    yield { type: 'done' };
  }),
  makeAssistantMessage: (content: unknown[]) => ({ role: 'assistant', content }),
  detectProvider: () => 'anthropic',
  getProviderModel: () => 'claude-test-model',
}));

// Real executeTool, wrapped so the tests can assert it was never reached.
vi.mock('../../core/tools.js', async (importActual) => {
  const actual = await importActual<typeof import('../../core/tools.js')>();
  return { ...actual, executeTool: vi.fn(actual.executeTool) };
});

import { Chat } from '../../tui/Chat.js';
import { executeTool, WRITE_TOOLS } from '../../core/tools.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const ANSI_RE = /\x1b\[[0-9;]*[mGKHFABCDJ]/g;
const frame = (r: ReturnType<typeof render>) => (r.lastFrame() ?? '').replace(ANSI_RE, '');

async function waitFor(assertion: () => void, timeout = 2000): Promise<void> {
  const deadline = Date.now() + timeout;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try { assertion(); return; } catch (e) { lastErr = e; }
    await new Promise((res) => setTimeout(res, 20));
  }
  throw lastErr;
}

function openChat() {
  return render(
    <Chat isActive onActivate={() => {}} onDeactivate={() => {}} onNavigate={() => {}} />,
  );
}

const tick = () => new Promise((res) => setTimeout(res, 20));

/** Type a message and press Enter, the way the owner does. Ink parses one
 *  write as one keypress, so Enter has to arrive on its own. */
async function ask(r: ReturnType<typeof render>, text: string): Promise<void> {
  r.stdin.write(text);
  await tick();
  r.stdin.write('\r');
  await tick();
}

/** Every tool_result the agent fed back to the provider, flattened. */
function toolResults(): string[] {
  return seenHistories
    .flat()
    .filter((m): m is { role: string; content: string } =>
      typeof m === 'object' && m !== null && (m as { role?: string }).role === 'tool_result')
    .map((m) => m.content);
}

/** A write tool that was added to WRITE_TOOLS without a describeToolCall arm. */
const UNDESCRIBED = 'delete_everything';

beforeEach(() => {
  scriptedTurns.length = 0;
  seenHistories.length = 0;
  vi.mocked(executeTool).mockClear();
});

afterEach(() => {
  cleanup();
  WRITE_TOOLS.delete(UNDESCRIBED);
});

afterAll(() => {
  const fs = require('fs') as typeof import('fs');
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

// ── A write tool with no description ──────────────────────────────────────────

describe('a write tool with no description', () => {
  it('is refused without running, the owner is told why, and the turn finishes', async () => {
    WRITE_TOOLS.add(UNDESCRIBED);
    scriptedTurns.push([
      { type: 'text', delta: 'Tidying that up. ' },
      { type: 'tool_use', id: 'call-1', name: UNDESCRIBED, input: { scope: 'all' } },
    ]);
    scriptedTurns.push([{ type: 'text', delta: 'That action was refused.' }]);

    const r = openChat();
    await ask(r, 'clean up my data');

    await waitFor(() => expect(frame(r)).toContain('That action was refused.'));
    const out = frame(r);

    // The owner is told, in the transcript, that this call could not be confirmed.
    expect(out).toContain('Refused');
    expect(out).toContain(UNDESCRIBED);
    expect(out).toContain('cannot be confirmed');

    // It was never offered for approval — approving a name you cannot read is
    // not consent, which is why describeToolCall refuses to render one.
    expect(out).not.toContain('[y] confirm');

    // It never ran.
    expect(vi.mocked(executeTool)).not.toHaveBeenCalled();

    // The turn survived: the streamed text is there and no exception was shown.
    expect(out).toContain('Tidying that up.');
    expect(out).not.toContain('Error:');

    // And the model was told, so it can say something useful instead of retrying.
    expect(toolResults().join('\n')).toMatch(/Refused/i);
  });

  it('does not take the rest of the turn down with it', async () => {
    WRITE_TOOLS.add(UNDESCRIBED);
    scriptedTurns.push([
      { type: 'tool_use', id: 'call-1', name: UNDESCRIBED, input: {} },
      { type: 'tool_use', id: 'call-2', name: 'spending_summary', input: { year: 2026, month: 8 } },
    ]);
    scriptedTurns.push([{ type: 'text', delta: 'Here is what I could get.' }]);

    const r = openChat();
    await ask(r, 'clean up and summarise');

    await waitFor(() => expect(frame(r)).toContain('Here is what I could get.'));

    // The read tool in the same assistant message still ran.
    expect(vi.mocked(executeTool).mock.calls.map((c) => c[0])).toEqual(['spending_summary']);
  });

  it('leaves the conversation usable for the next message', async () => {
    WRITE_TOOLS.add(UNDESCRIBED);
    scriptedTurns.push([{ type: 'tool_use', id: 'call-1', name: UNDESCRIBED, input: {} }]);
    scriptedTurns.push([{ type: 'text', delta: 'Refusing that.' }]);
    scriptedTurns.push([{ type: 'text', delta: 'Your August spend was $1,234.' }]);

    const r = openChat();
    await ask(r, 'clean up my data');
    await waitFor(() => expect(frame(r)).toContain('Refusing that.'));

    await ask(r, 'what did I spend in August?');
    await waitFor(() => expect(frame(r)).toContain('Your August spend was $1,234.'));

    // The refused turn is still in the history the provider sees — Chat.tsx
    // rolls history back only when the turn throws, and it must not throw.
    const finalHistory = seenHistories.at(-1)!;
    expect(JSON.stringify(finalHistory)).toContain(UNDESCRIBED);
  });
});

// ── The described path, which must keep working ───────────────────────────────

describe('a write tool that does have a description', () => {
  it('still asks the owner, and runs only after they say yes', async () => {
    scriptedTurns.push([
      { type: 'tool_use', id: 'call-1', name: 'toggle_hidden_category', input: { category: 'Dining', hide: true } },
    ]);
    scriptedTurns.push([{ type: 'text', delta: 'Dining is hidden now.' }]);

    const r = openChat();
    await ask(r, 'hide dining');

    await waitFor(() => expect(frame(r)).toContain('[y] confirm'));
    expect(frame(r)).toContain('Hide category "Dining"');
    expect(vi.mocked(executeTool)).not.toHaveBeenCalled();

    r.stdin.write('y');
    await waitFor(() => expect(frame(r)).toContain('Dining is hidden now.'));
    expect(vi.mocked(executeTool).mock.calls.map((c) => c[0])).toEqual(['toggle_hidden_category']);
  });

  it('does not run when the owner says no', async () => {
    scriptedTurns.push([
      { type: 'tool_use', id: 'call-1', name: 'toggle_hidden_category', input: { category: 'Dining', hide: true } },
    ]);
    scriptedTurns.push([{ type: 'text', delta: 'Left it visible.' }]);

    const r = openChat();
    await ask(r, 'hide dining');

    await waitFor(() => expect(frame(r)).toContain('[y] confirm'));
    r.stdin.write('n');

    await waitFor(() => expect(frame(r)).toContain('Left it visible.'));
    expect(vi.mocked(executeTool)).not.toHaveBeenCalled();
    expect(toolResults()).toContain('Cancelled.');
  });
});
