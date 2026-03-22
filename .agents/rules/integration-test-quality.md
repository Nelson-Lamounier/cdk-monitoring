---
trigger: always_on
---

# Integration Test & TypeScript Code Quality Rules

Applies to: `**/*.test.ts`, `**/*.spec.ts`, `**/integration/**/*.ts`, `**/test/**/*.ts`

---

## 1. Resource Caching — No Repeated API Calls

When writing or refactoring integration tests that call external APIs (AWS SDK, HTTP, etc.),
all shared resources must be fetched exactly once and cached at the appropriate scope.

**Rules:**
- Fetch shared test data in a single top-level or describe-level `beforeAll`. Never inside individual `it` blocks unless the data is genuinely test-specific.
- Never call the same API endpoint more than once within the same `describe` block. Store the result in a `beforeAll`-scoped variable.
- Module-level resources used across multiple `describe` blocks (e.g. a load balancer ARN, an SSM parameter map) must be declared at module scope and populated in a single top-level `beforeAll`.
- Never define `async` helper functions that call APIs and are invoked inside multiple `it` blocks — this creates N redundant round-trips. Move the call to `beforeAll` instead.

**Before (incorrect):**
```ts
it('should be internet-facing', async () => {
    const { LoadBalancers } = await elbv2.send(
        new DescribeLoadBalancersCommand({ Names: ['my-nlb'] }),
    );
    expect(LoadBalancers![0].Scheme).toBe('internet-facing');
});

it('should be of type network', async () => {
    const { LoadBalancers } = await elbv2.send(
        new DescribeLoadBalancersCommand({ Names: ['my-nlb'] }),
    );
    expect(LoadBalancers![0].Type).toBe('network');
});
```

**After (correct):**
```ts
describe('NLB — Configuration', () => {
    let nlb: LoadBalancer;

    beforeAll(async () => {
        const { LoadBalancers } = await elbv2.send(
            new DescribeLoadBalancersCommand({ Names: ['my-nlb'] }),
        );
        expect(LoadBalancers).toHaveLength(1);
        nlb = LoadBalancers![0];
    });

    it('should be internet-facing', () => {
        expect(nlb.Scheme).toBe('internet-facing');
    });

    it('should be of type network', () => {
        expect(nlb.Type).toBe('network');
    });
});
```

---

## 2. Non-Null Assertions — Use a `requireParam` Helper

Never use the TypeScript non-null assertion operator (`!`) to unwrap values that
originated from external data sources (API responses, Maps, environment variables).
These produce cryptic runtime errors with no context.

**Rules:**
- Create and use a `requireParam` (or similar) guard helper for any value retrieved from a `Map`, an API response, or `process.env`.
- The helper must throw a descriptive `Error` — not just re-throw or return `undefined`.
- Reserve `!` only for values that have been explicitly narrowed by a preceding `expect(...).toBeDefined()` assertion in the same block.

**Required helper pattern:**
```ts
function requireParam(params: Map<string, string>, path: string): string {
    const value = params.get(path);
    if (!value) throw new Error(`Missing required SSM parameter: ${path}`);
    return value;
}
```

**Before (incorrect):**
```ts
const vpcId = ssmParams.get(SSM_PATHS.vpcId)!;
const keyArn = ssmParams.get(SSM_PATHS.kmsKeyArn)!;
```

**After (correct):**
```ts
const vpcId = requireParam(ssmParams, SSM_PATHS.vpcId);
const keyArn = requireParam(ssmParams, SSM_PATHS.kmsKeyArn);
```

---

## 3. Magic Values — Named Constants Only

Inline string literals and numeric literals that encode configuration, thresholds,
or business rules must not appear in assertion bodies.

**Rules:**
- All CIDR prefixes, retention periods, port numbers used in multiple places, and TTL values must be declared as `const` at the top of the file (or in a shared constants module).
- A value used in two or more assertions is always a named constant — no exceptions.
- Names must be descriptive and encode intent, not just value (e.g. `VPC_CIDR_PREFIX`, not `TEN_DOT`).

**Required constants pattern:**
```ts
// Networking
const VPC_CIDR_PREFIX   = '10.';
const POD_CIDR_PREFIX   = '192.168.';
const ANY_IPV4          = '0.0.0.0/0';

// Retention / lifecycle
const LOG_RETENTION_DAYS = 3;
const NLB_LOG_PREFIX     = 'nlb-access-logs';
const API_RECORD_TTL     = 30;
```

**Before (incorrect):**
```ts
expect(logGroup!.retentionInDays).toBe(3);
expect(expirationRule!.Expiration!.Days).toBe(3);
expectCidrSource(rule!, '10.');
expectCidrSource(rule!, '192.168.');
```

**After (correct):**
```ts
expect(logGroup.retentionInDays).toBe(LOG_RETENTION_DAYS);
expect(expirationRule.Expiration!.Days).toBe(LOG_RETENTION_DAYS);
expectCidrSource(rule, VPC_CIDR_PREFIX);
expectCidrSource(rule, POD_CIDR_PREFIX);
```

---

## 4. Environment Variable Parsing — No Silent `as` Casts

Never cast `process.env` values directly to domain types using `as`. This is a
runtime type lie that silently accepts invalid input and produces confusing
downstream failures.

**Rules:**
- All `process.env` values that are used as typed domain values (enums, union types) must go through an explicit validation function before use.
- The validator must throw with the invalid value included in the error message.
- Zod (`z.enum`) or a plain guard function are both acceptable. Raw `as` casts are not.

**Before (incorrect):**
```ts
const CDK_ENV = (process.env.CDK_ENV ?? 'development') as Environment;
```

**After (correct):**
```ts
function parseEnvironment(raw: string): Environment {
    const valid = ['development', 'staging', 'production'] as const satisfies Environment[];
    if (!valid.includes(raw as Environment)) {
        throw new Error(`Invalid CDK_ENV: "${raw}". Expected one of: ${valid.join(', ')}`);
    }
    return raw as Environment;
}

const CDK_ENV = parseEnvironment(process.env.CDK_ENV ?? 'development');
```

---

## 5. `satisfies` Operator — Prefer Over `as` for Typed Literals

When defining typed arrays of objects (e.g. test case parameters, config tuples),
use the `satisfies` operator instead of `as` type assertions. This catches
structural errors at the point of definition rather than silently widening the type.

**Rules:**
- Use `satisfies` for `it.each` parameter arrays and config object arrays where you want type-checking without losing literal inference.
- Do not use `as const` alone when the shape also needs to be validated against an interface.

**Before (incorrect):**
```ts
const sgKeys = [
    { key: 'securityGroupId', label: 'Cluster Base' },
    { key: 'controlPlaneSgId', label: 'Control Plane' },
] as const;
```

**After (correct):**
```ts
const sgKeys = [
    { key: 'securityGroupId', label: 'Cluster Base' },
    { key: 'controlPlaneSgId', label: 'Control Plane' },
] satisfies Array<{ key: keyof typeof SSM_PATHS; label: string }>;
```

---

## 6. Import Style — Enforce `import type` for Type-Only Imports

All imports that are used exclusively as types (not as values at runtime) must use
`import type`. This is required for compatibility with `verbatimModuleSyntax` and
`isolatedModules`, both of which are standard in CDK TypeScript projects.

**Rules:**
- If an import is only used in type positions (function signatures, variable annotations, `satisfies` expressions), it must use `import type`.
- SDK client imports used as constructor values (`new SSMClient()`) are value imports — do not use `import type` for these.
- Run `tsc --noEmit` or rely on ESLint `@typescript-eslint/consistent-type-imports` to enforce this automatically.

**Before (incorrect):**
```ts
import { IpPermission } from '@aws-sdk/client-ec2';
import { Environment } from '../lib/config';
```

**After (correct):**
```ts
import type { IpPermission } from '@aws-sdk/client-ec2';
import type { Environment } from '../lib/config';
```

---

## 7. Test Redundancy — Avoid Assertions That Restate Earlier Tests

A test that only re-checks values already verified by other tests in the same suite
adds noise to failure reports without providing new diagnostic signal.

**Rules:**
- A "readiness gate" or "smoke check" test is only justified if it verifies a cross-cutting contract not covered by individual tests (e.g. a downstream stack's expected interface, a published contract file).
- If a test would fail for exactly the same reason as an earlier test in the same run, remove it or merge it.
- Prefer one well-scoped failing test over three tests that all fail for the same root cause.

---

## 8. AWS API Response Narrowing — Validate Shape Before Accessing

Never access array indices or nested properties of AWS API responses without
first asserting the expected shape. A bare `[0]` on an undefined array produces
an unreadable error at a location far from the root cause.

**Rules:**
- Always assert `expect(Collection).toHaveLength(n)` or `expect(Collection?.length).toBeGreaterThan(0)` before accessing `Collection[0]`.
- Use `??` fallback to `[]` **only inside `beforeAll` or module-level helpers** — never inside `it()` blocks, where it triggers `jest/no-conditional-in-test` (see Rule 11).
- After the shape assertion, assign to a typed local variable — do not inline `Response![0].Property` across multiple expressions.

**Before (incorrect):**
```ts
const { Vpcs } = await ec2.send(new DescribeVpcsCommand({ VpcIds: [vpcId] }));
expect(Vpcs![0].State).toBe('available');
```

**After (correct):**
```ts
const { Vpcs } = await ec2.send(new DescribeVpcsCommand({ VpcIds: [vpcId] }));
expect(Vpcs).toHaveLength(1);
const vpc = Vpcs![0];
expect(vpc.State).toBe('available');
```

---

## 9. Describe-Level `beforeAll` Ordering — Document Implicit Dependencies

When a nested `describe` block's `beforeAll` depends on data populated by an outer
`beforeAll` (e.g. `ssmParams`), this ordering dependency must be made explicit.

**Rules:**
- Add a one-line comment above any `beforeAll` that reads from a variable populated by an outer scope.
- If the dependency is non-obvious, assert the prerequisite at the start of the inner `beforeAll` rather than letting it fail silently on a property access.

**Correct pattern:**
```ts
describe('KMS Key', () => {
    // Depends on: ssmParams populated in top-level beforeAll
    it('should exist and be enabled', async () => {
        const keyArn = requireParam(ssmParams, SSM_PATHS.kmsKeyArn);
        // ...
    });
});
```

---

## 10. Helper Function Scope — Extract to Module Level

Helper functions used across two or more `describe` blocks must be defined at
module level, not inside a `describe` or `it` block.

**Rules:**
- Any `async` helper that calls an AWS API and is used in multiple describe blocks must be a module-level `async function`, with its result cached in a module-level variable.
- Helper functions that only contain assertions (no API calls) may be defined at module level or in a shared `test-utils` file.
- Inner functions defined inside `describe` solely to wrap a repeated API call must be refactored into a module-level cached variable.
- **Predicate functions** passed to `.find()`, `.filter()`, or `.some()` that contain `&&` or `||` must be extracted to named module-level helpers (see Rule 11).

**Before (incorrect):**
```ts
describe('S3 NLB Access Logs Bucket', () => {
    async function getNlbArn(): Promise<string> { /* calls AWS */ }
    async function findNlbLogBucket(): Promise<string> { /* calls getNlbArn */ }

    it('test 1', async () => { const b = await findNlbLogBucket(); });
    it('test 2', async () => { const b = await findNlbLogBucket(); });
});
```

**After (correct):**
```ts
// Module level
let nlbArn: string;
let nlbLogBucket: string;

beforeAll(async () => {
    const { LoadBalancers } = await elbv2.send(
        new DescribeLoadBalancersCommand({ Names: [`${NAME_PREFIX}-nlb`] }),
    );
    nlbArn = LoadBalancers![0].LoadBalancerArn!;

    const { Attributes } = await elbv2.send(
        new DescribeLoadBalancerAttributesCommand({ LoadBalancerArn: nlbArn }),
    );
    nlbLogBucket = Attributes?.find((a) => a.Key === 'access_logs.s3.bucket')?.Value ?? '';
    expect(nlbLogBucket).toBeTruthy();
});

describe('S3 NLB Access Logs Bucket', () => {
    it('test 1', async () => { /* use nlbLogBucket directly */ });
    it('test 2', async () => { /* use nlbLogBucket directly */ });
});
```

---

## 11. No Conditionals in Test Blocks — `jest/no-conditional-in-test`

The ESLint rule `jest/no-conditional-in-test` forbids **any** conditional
expression inside `it()` / `test()` callbacks. This includes operators
that are easy to overlook:

| Operator | Common source | Flagged? |
|---|---|---|
| `if` / `else` / `switch` | Branching logic | ✅ |
| `? :` (ternary) | Inline defaults | ✅ |
| `&&` / `\|\|` | `.find()` / `.filter()` / `.some()` predicates | ✅ |
| `??` (nullish coalescing) | API response fallbacks (`tags ?? []`) | ✅ |

**Why:** Conditionals make tests non-deterministic. A test should always
assert **or** always fail — never silently skip an assertion because a
branch was not taken.

**ESLint severity:**
- Unit tests (`**/*.test.ts`): `error`
- Integration tests (`tests/integration/**`): `warn` (treated as error in CI via `--max-warnings`)

### Fix Pattern 1 — Move `??` into `beforeAll`

The most common violation. API response narrowing (`?? []`, `?? ''`)
must happen in `beforeAll`, not inside `it()`.

**Before (incorrect):**
```ts
it('should have the KubernetesVersion tag', async () => {
    const { Images } = await ec2.send(
        new DescribeImagesCommand({ ImageIds: [amiId] }),
    );
    const tags = Images?.[0]?.Tags ?? [];  // ← jest/no-conditional-in-test
    const k8sTag = tags.find(t => t.Key === 'KubernetesVersion');
    expect(k8sTag).toBeDefined();
});
```

**After (correct):**
```ts
describe('AMI Metadata', () => {
    let tags: Array<{ Key?: string; Value?: string }>;

    beforeAll(async () => {
        const { Images } = await ec2.send(
            new DescribeImagesCommand({ ImageIds: [amiId] }),
        );
        expect(Images).toBeDefined();
        expect(Images!).toHaveLength(1);
        tags = Images![0].Tags ?? [];        // ← safe here, outside it()
    });

    it('should have the KubernetesVersion tag', () => {
        const k8sTag = tags.find(t => t.Key === 'KubernetesVersion');
        expect(k8sTag).toBeDefined();
    });
});
```

### Fix Pattern 2 — Extract `.find()` predicates into module-level helpers

When a `.find()` / `.filter()` / `.some()` callback contains `&&` or `||`,
the predicate itself triggers the lint rule. Extract it to a named helper.

**Before (incorrect):**
```ts
it('should allow TCP 443 from VPC CIDR', () => {
    const rule = ingress.find(
        (r) => r.FromPort === 443 && r.ToPort === 443 && r.IpProtocol === 'tcp',
        //                      ^^                   ^^ jest/no-conditional-in-test
    );
    expect(rule).toBeDefined();
});
```

**After (correct):**
```ts
// Module level — predicate logic lives outside it()
function findRule(
    rules: IpPermission[],
    fromPort: number,
    toPort: number,
    protocol: string,
): IpPermission | undefined {
    return rules.find(
        (r) => r.FromPort === fromPort && r.ToPort === toPort && r.IpProtocol === protocol,
    );
}

// Inside test suite
it('should allow TCP 443 from VPC CIDR', () => {
    const rule = findRule(ingress, 443, 443, 'tcp');
    expect(rule).toBeDefined();
});
```

### Fix Pattern 3 — Replace `if` / ternary with separate tests or `it.each`

If a test branches on a condition to run different assertions, split it
into separate `it()` blocks or use `it.each()` for data-driven tests.

**Before (incorrect):**
```ts
it('should log parameters if present', () => {
    if (ssmParams.size > 0) {    // ← jest/no-conditional-in-test
        console.log(`Keys: ${[...ssmParams.keys()].join(', ')}`);
    }
    expect(ssmParams.size).toBeGreaterThan(0);
});
```

**After (correct):**
```ts
it('should have loaded SSM parameters', () => {
    console.log(`Parameters loaded: ${ssmParams.size}`);
    expect(ssmParams.size).toBeGreaterThan(0);
});
```
```