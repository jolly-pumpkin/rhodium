# Rhodium Capabilities

Defines and validates capability contracts using TypeScript type-level programming.

## Key Modules

- `define.ts` — `defineCapability<T>(name: string, validator?: Validator<T>)`
- `validate.ts` — Runtime validation of provider/consumer shapes

## Patterns

**Defining a capability:**
```typescript
const DatabaseCapability = defineCapability<Database>('database', {
  validate: (obj) => 'query' in obj && typeof obj.query === 'function'
});
```

**Type safety:** All capabilities use TypeScript interface types. Validation must mirror the interface exactly.

**Error handling:** If a provider doesn't match the contract, throw `CapabilityViolationError` during activation (not at runtime).

## Tests

- Type-level tests verifying TypeScript catches mismatches
- Runtime validation tests for each built-in capability (Broker, PluginContext, etc.)
- Integration test: provider shape doesn't match interface → CapabilityViolationError at activate

## Interdependencies

- Depends on: core error types
- Depended on by: core (registry uses validators)
