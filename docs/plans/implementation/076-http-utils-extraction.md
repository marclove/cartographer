# Task 76: Extract HTTP Utilities

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Extract `jsonResponse` and `jsonError` from `tree-server.ts` into a standalone `http-utils.ts` module, breaking the circular import between `tree-server.ts` and `api-handlers.ts`.

**Depends on:** None

---

### Step 1: Write failing tests

Create `src/server/http-utils.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { jsonResponse, jsonError } from './http-utils.js';
import type { ServerResponse } from 'node:http';

function mockResponse() {
  return {
    writeHead: vi.fn(),
    end: vi.fn(),
  } as unknown as ServerResponse;
}

describe('jsonResponse', () => {
  it('writes JSON content-type header and stringified body', () => {
    const res = mockResponse();
    jsonResponse(res, 200, { ok: true });

    expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
    expect(res.end).toHaveBeenCalledWith(JSON.stringify({ ok: true }));
  });

  it('uses the provided status code', () => {
    const res = mockResponse();
    jsonResponse(res, 201, { created: true });

    expect(res.writeHead).toHaveBeenCalledWith(201, { 'Content-Type': 'application/json' });
  });
});

describe('jsonError', () => {
  it('writes error object with message and status', () => {
    const res = mockResponse();
    jsonError(res, 404, 'Not found');

    expect(res.writeHead).toHaveBeenCalledWith(404, { 'Content-Type': 'application/json' });
    expect(res.end).toHaveBeenCalledWith(JSON.stringify({ error: 'Not found', status: 404 }));
  });
});
```

### Step 2: Run tests to verify they fail

Run: `npx vitest run src/server/http-utils.test.ts`
Expected: FAIL — module `./http-utils.js` does not exist.

### Step 3: Create http-utils.ts

Create `src/server/http-utils.ts`:

```ts
import type { ServerResponse } from 'node:http';

export function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function jsonError(res: ServerResponse, status: number, message: string): void {
  jsonResponse(res, status, { error: message, status });
}
```

### Step 4: Run tests to verify they pass

Run: `npx vitest run src/server/http-utils.test.ts`
Expected: All pass.

### Step 5: Update imports in tree-server.ts and api-handlers.ts

Edit `src/server/tree-server.ts`:
- Remove the `jsonResponse` and `jsonError` function definitions.
- Add import: `import { jsonResponse, jsonError } from './http-utils.js';`

Edit `src/server/api-handlers.ts`:
- Change `import { jsonResponse, jsonError } from './tree-server.js';`
  to `import { jsonResponse, jsonError } from './http-utils.js';`

### Step 6: Typecheck and run all tests

Run: `npm run typecheck`
Expected: All pass.

Run: `npm run test`
Expected: All pass.

Run: `npm run test:integration`
Expected: All pass.

### Step 7: Commit

```bash
git add src/server/http-utils.ts src/server/http-utils.test.ts src/server/tree-server.ts src/server/api-handlers.ts
git commit -m "refactor(server): extract jsonResponse/jsonError into http-utils module"
```
