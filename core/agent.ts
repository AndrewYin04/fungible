/**
 * Agent core — runs the agentic loop using the detected LLM provider.
 * Tool implementations live in core/tools.ts (shared with mcp/server.ts).
 */

import 'dotenv/config';
import { streamResponse, makeAssistantMessage, detectProvider, getProviderModel } from './llm-provider.js';
import type { Message, ContentBlock, ToolDef } from './llm-provider.js';
import { APP_CONTEXT } from './agent-context.js';
import { TOOL_DEFS, WRITE_TOOLS, describeToolCall, executeTool, toConfirmationLine } from './tools.js';
import { loadCanvasContext } from './canvas-agent.js';
import { buildPriorCanvasesSection } from './canvas-history.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type AgentCallbacks = {
  /** Called for each streaming text chunk. */
  onText: (delta: string) => void;
  /** Called when the agent starts executing a tool. */
  onToolCall: (name: string, humanDesc: string) => void;
  /** Called when a write tool needs confirmation. Resolves true = proceed. */
  onConfirm: (humanDesc: string) => Promise<boolean>;
  /** Called by the `show` tool to navigate the UI. */
  onNavigate: (screen: string, filter?: Record<string, string>) => void;
};

// ─── System prompt ────────────────────────────────────────────────────────────

function buildSystemPrompt(): string {
  const provider = (() => { try { return detectProvider(); } catch { return 'unknown'; } })();
  const model    = (() => { try { return getProviderModel(provider as 'anthropic' | 'openai'); } catch { return ''; } })();

  return `You are a personal finance assistant embedded in fungible, a terminal-based personal finance app.
You run inside the app itself — you can read the user's financial data, take actions on their behalf (with confirmation), and navigate the app UI to show them relevant views.

${APP_CONTEXT}

## Personal Finance Philosophy

Follow this priority waterfall — do steps in order:
1. Employer 401k match — always capture the full match first (it's a guaranteed 50–100% return)
2. High-interest debt (>6–7%) — eliminate before investing; guaranteed return beats the market
3. Emergency fund (3–6 months expenses) — HYSA only, not invested
4. HSA — triple tax advantage if you have an HDHP; max it and invest the balance
5. IRA — Roth if income allows ($7k/yr limit); Traditional or Backdoor Roth otherwise
6. 401k beyond match — max it ($23k/yr limit); pick lowest-expense index funds
7. Medium-interest debt (3–6%) — judgment call vs investing
8. Taxable investing — total-market index funds, low cost
9. Low-interest debt (<3%) — mathematically better to invest; pay if it bothers you

Use \`get_finance_guide\` for detailed guidance on any topic.

## Behavior
- Proactively fetch relevant data before answering financial questions — don't answer blind
- Use the \`show\` tool to navigate the app to the most relevant screen when it helps understanding
- Be concise. Use numbers from actual data rather than generalities.
- For write operations, be specific about exactly what will change before asking confirmation
- When the user asks about their situation, compare it to the priority waterfall and give actionable advice

Model in use: ${model}
`.trim();
}

// ─── Agent-only tool: `show` ──────────────────────────────────────────────────

const SHOW_TOOL: ToolDef = {
  name: 'show',
  description: 'Navigate the app UI to display a specific screen or filtered view. Use this to show the user relevant data visually. For "canvas", pass the generated CanvasSpec as a JSON string in canvasSpec.',
  parameters: {
    type: 'object',
    properties: {
      screen:      { type: 'string', description: 'Screen to navigate to', enum: ['dashboard', 'transactions', 'trends', 'networth', 'tags', 'rules', 'accounts', 'health', 'canvas'] },
      category:    { type: 'string', description: 'Filter transactions by category' },
      from:        { type: 'string', description: 'Start date YYYY-MM-DD' },
      to:          { type: 'string', description: 'End date YYYY-MM-DD' },
      tag:         { type: 'string', description: 'Filter by tag' },
      account:     { type: 'string', description: 'Filter by account ID' },
      accountName: { type: 'string', description: 'Account display name (paired with account)' },
      search:      { type: 'string', description: 'Pre-fill the search box on the transactions screen (regex)' },
      range:       { type: 'string', description: 'Time range to show on dashboard or trends', enum: ['week', 'month', 'quarter', 'year', 'alltime'] },
      anchor:      { type: 'string', description: 'Which period to land on — any date within it, YYYY-MM-DD (e.g. "2026-03-01" for March 2026)' },
      canvasSpec:  { type: 'string', description: 'JSON-encoded CanvasSpec (required when screen is "canvas")' },
    },
    required: ['screen'],
  },
};

const GENERATE_CANVAS_TOOL: ToolDef = {
  name: 'generate_canvas',
  description: 'Load live financial data and the canvas schema. Returns context needed to build a CanvasSpec — including any prior canvases that cover a similar problem, so you can build on them rather than starting from scratch. After calling this, generate the CanvasSpec JSON following the returned instructions, then call show_canvas({ spec: JSON.stringify(spec), prompt: "<original user question>" }) to render and save it.',
  parameters: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'The user\'s canvas question, used to search for relevant prior canvases' },
    },
    required: ['prompt'],
  },
};

const AGENT_TOOL_DEFS: ToolDef[] = [...TOOL_DEFS, SHOW_TOOL, GENERATE_CANVAS_TOOL];

// ─── Describing a tool call to the owner ──────────────────────────────────────

/**
 * describeToolCall() throws for a write tool nobody has written a description
 * for, rather than asking the owner to approve a bare tool name. That is
 * correct and stays: a name you cannot read is not something you can consent to.
 *
 * What is not correct is letting the throw out of here. It fires while the
 * assistant's message is still streaming — before any tool runs — so it escaped
 * runAgentTurn entirely and took the whole turn with it: the streamed answer,
 * every other tool call in the same message, and the turn's history, which both
 * front ends roll back on an exception (tui/Chat.tsx, gui/main/agent-ipc.ts).
 * One undescribed tool would have ended the conversation instead of being
 * refused.
 *
 * So a description that cannot be produced becomes a refusal the owner reads
 * and the model is told about, and dispatchTool never runs that call.
 */
type Description =
  | { ok: true;  ownerText: string }
  | { ok: false; ownerText: string; reason: string };

function describeForOwner(name: string, input: Record<string, unknown>): Description {
  try {
    return { ok: true, ownerText: describeToolCall(name, input) };
  } catch (err) {
    // Front matter first: each front end fits this to its own window, so the
    // verdict and the tool name have to survive the clip. `name` came off the
    // model like every other value in a confirmation, so it goes through the
    // same one-line bound rather than being trusted to be a plain identifier.
    return {
      ok: false,
      ownerText: toConfirmationLine(
        `Refused "${name}": it cannot be confirmed — no description exists for this write tool`,
      ),
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

// ─── Tool dispatch (agent layer: show + confirmation wrapper) ──────────────────

async function dispatchTool(
  name: string,
  input: Record<string, unknown>,
  callbacks: AgentCallbacks,
): Promise<string> {
  // Load canvas context — agent generates spec, then calls show_canvas
  if (name === 'generate_canvas') {
    const prompt = String(input.prompt ?? '');
    const { system, tool } = await loadCanvasContext();
    return [
      `## User prompt\n${prompt}`,
      buildPriorCanvasesSection(prompt),
      `## Canvas instructions\n${system}`,
      `## render_canvas tool schema\n${JSON.stringify(tool, null, 2)}`,
      `Now generate the CanvasSpec JSON following these instructions, then call show_canvas({ spec: JSON.stringify(spec), prompt: ${JSON.stringify(prompt)} }).`,
    ].filter(Boolean).join('\n\n');
  }

  // UI navigation — agent-only, no confirmation
  if (name === 'show') {
    const { screen, canvasSpec, ...rest } = input as Record<string, string>;
    const filter: Record<string, string> = {};
    for (const [k, v] of Object.entries(rest)) {
      if (v !== undefined && v !== null) filter[k] = String(v);
    }
    if (canvasSpec) filter['canvasSpec'] = canvasSpec;
    callbacks.onNavigate(screen, filter);
    return `Navigated to ${screen}`;
  }

  // Write tools — confirm before executing
  if (WRITE_TOOLS.has(name)) {
    const described = describeForOwner(name, input);
    // Nothing to ask. Putting an undescribable write in front of the owner as a
    // yes/no is the failure this gate exists to prevent, so refuse it outright
    // and tell the model why rather than executing or prompting.
    if (!described.ok) return `Refused: ${described.reason}`;
    const confirmed = await callbacks.onConfirm(described.ownerText);
    if (!confirmed) return 'Cancelled.';
  }

  return executeTool(name, input);
}

// ─── Agent loop ───────────────────────────────────────────────────────────────

/**
 * Run one user turn through the agent loop.
 * Mutates `history` in place (appends messages).
 * Streams text via callbacks; pauses for confirmation on write tools.
 */
export async function runAgentTurn(
  userMessage: string,
  history: Message[],
  callbacks: AgentCallbacks,
): Promise<void> {
  history.push({ role: 'user', content: userMessage });

  const system = buildSystemPrompt();

  while (true) {
    const currentBlocks: ContentBlock[] = [];
    let   currentText = '';

    for await (const chunk of streamResponse(system, history, AGENT_TOOL_DEFS)) {
      if (chunk.type === 'text') {
        currentText += chunk.delta;
        callbacks.onText(chunk.delta);
      } else if (chunk.type === 'tool_use') {
        if (chunk.name !== 'show') {
          // Never a bare describeToolCall() here: this runs mid-stream, so a
          // throw would end the turn instead of refusing the one call.
          callbacks.onToolCall(chunk.name, describeForOwner(chunk.name, chunk.input).ownerText);
        }
        currentBlocks.push({ type: 'tool_use', id: chunk.id, name: chunk.name, input: chunk.input });
      }
    }

    if (currentText) currentBlocks.unshift({ type: 'text', text: currentText });
    history.push(makeAssistantMessage(currentBlocks));

    const toolCalls = currentBlocks.filter((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use');
    if (!toolCalls.length) break;

    for (const call of toolCalls) {
      let result: string;
      try {
        result = await dispatchTool(call.name, call.input as Record<string, unknown>, callbacks);
      } catch (e) {
        result = `Error: ${e instanceof Error ? e.message : String(e)}`;
      }
      history.push({ role: 'tool_result', tool_use_id: call.id, content: result });
    }
  }
}
