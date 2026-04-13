import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { createBroker, defineCapability, createCapabilityValidator } from './index.js';
import type { Broker, Plugin, ActivationResult } from './index.js';

// -- Capability contract ------------------------------------------------------

interface Greeter {
  greet(name: string): string;
}

const GreeterContract = defineCapability<Greeter>('greeter');

// -- Plugins ------------------------------------------------------------------

const englishGreeter: Plugin = {
  key: 'english-greeter',
  version: '1.0.0',
  manifest: {
    name: 'English Greeter',
    description: 'Greets people in English',
    provides: [{ capability: 'greeter' }],
    needs: [],
  },
  activate(ctx) {
    ctx.provide<Greeter>('greeter', {
      greet: (name: string) => `Hello, ${name}!`,
    });
  },
};

const greetingOrchestrator: Plugin = {
  key: 'greeting-orchestrator',
  version: '1.0.0',
  manifest: {
    name: 'Greeting Orchestrator',
    description: 'Orchestrates greetings via commands',
    provides: [],
    needs: [{ capability: 'greeter' }],
  },
  activate(ctx) {
    const greeter = ctx.resolve<Greeter>('greeter');
    ctx.registerCommand('say-hello', async (...args: unknown[]) => {
      return greeter.greet((args[0] as string) ?? '');
    });
  },
};

// -- Suite --------------------------------------------------------------------

describe('ARD Appendix B: Minimal Working Example', () => {
  let broker: Broker;
  let activationResult: ActivationResult;

  beforeAll(async () => {
    broker = createBroker();
    broker.register(englishGreeter);
    broker.register(greetingOrchestrator);
    activationResult = await broker.activate();
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

  it('exposes manifests via getManifests()', () => {
    const manifests = broker.getManifests();
    expect(manifests.has('english-greeter')).toBe(true);
    expect(manifests.get('english-greeter')?.name).toBe('English Greeter');
    expect(manifests.get('english-greeter')?.description).toBe('Greets people in English');
  });

  it('exposes individual manifest via getManifest()', () => {
    const manifest = broker.getManifest('greeting-orchestrator');
    expect(manifest).toBeDefined();
    expect(manifest?.name).toBe('Greeting Orchestrator');
  });
});
