import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { createBroker, defineCapability, createCapabilityValidator } from './index.js';
import type { Broker, Plugin, ActivationResult, AssembledContext } from './index.js';

// ── Capability contract ───────────────────────────────────────────────────────

interface Greeter {
  greet(name: string): string;
}

const GreeterContract = defineCapability<Greeter>('greeter');

// ── Plugins ───────────────────────────────────────────────────────────────────

const englishGreeter: Plugin = {
  key: 'english-greeter',
  version: '1.0.0',
  manifest: {
    description: 'Greets people in English',
    provides: [{ capability: 'greeter' }],
    needs: [],
    tools: [
      {
        name: 'greet',
        description: 'Greet a person by name',
        parameters: {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name'],
        },
        examples: [
          {
            scenario: 'Basic greeting',
            input: { name: 'Alice' },
            output: 'Hello, Alice!',
          },
        ],
      },
    ],
  },
  activate(ctx) {
    ctx.provide<Greeter>('greeter', {
      greet: (name: string) => `Hello, ${name}!`,
    });
    ctx.registerToolHandler('greet', async (params) => ({
      content: `Hello, ${params['name']}!`,
    }));
  },
  contributeContext() {
    return {
      pluginKey: 'english-greeter',
      priority: 50,
      systemPromptFragment: 'You can greet people in English.',
    };
  },
};

const greetingOrchestrator: Plugin = {
  key: 'greeting-orchestrator',
  version: '1.0.0',
  manifest: {
    provides: [],
    needs: [{ capability: 'greeter' }],
    tools: [],
  },
  activate(ctx) {
    const greeter = ctx.resolve<Greeter>('greeter');
    // TODO: test command execution once broker.runCommand() is on the public API
    ctx.registerCommand('say-hello', (args) => {
      return greeter.greet(args[0] ?? '');
    });
  },
};

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('ARD Appendix B: Minimal Working Example', () => {
  let broker: Broker;
  let activationResult: ActivationResult;
  let assembled: AssembledContext;

  beforeAll(async () => {
    broker = createBroker({ defaultTokenBudget: { maxTokens: 4096 } });
    broker.register(englishGreeter);
    broker.register(greetingOrchestrator);
    activationResult = await broker.activate();
    assembled = broker.assembleContext({ tokenBudget: { maxTokens: 4096 } });
  });

  afterAll(async () => {
    await broker.deactivate();
  });

  it('activates all plugins successfully', () => {
    expect(activationResult.activated).toContain('english-greeter');
    expect(activationResult.activated).toContain('greeting-orchestrator');
    expect(activationResult.failed).toHaveLength(0);
  });

  it('resolves the greeter capability end-to-end', () => {
    const greeter = broker.resolve<Greeter>('greeter');
    expect(greeter.greet('World')).toBe('Hello, World!');
    const validator = createCapabilityValidator();
    const violations = validator.validate(GreeterContract, greeter);
    expect(violations).toEqual([]);
  });

  it('assembles context with expected system prompt, tools, and examples', () => {
    expect(assembled.systemPrompt).toContain('You can greet people in English.');
    const greetTool = assembled.tools.find((t) => t.name === 'greet');
    expect(greetTool).toBeDefined();
    expect(greetTool?.examples).toHaveLength(1);
    expect(greetTool?.examples?.[0].scenario).toBe('Basic greeting');
  });

});
