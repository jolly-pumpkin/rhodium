---
name: bun-test
description: Run test suites for all packages in the monorepo using Bun
disable-model-invocation: true
---

# Run Tests

Runs the test suite for all packages in the Rhodium monorepo using Bun.

## Command
```bash
bun --filter '*' test
```

## What this does
- Runs tests in all workspace packages
- Uses Bun's workspace filtering to run tests in parallel where possible
- Reports results for each package
