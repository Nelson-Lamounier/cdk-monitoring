/** @format */

/**
 * Custom ESLint rules for CDK test safety
 *
 * These rules prevent common timing issues in Jest tests where code
 * executes during module initialization (in describe blocks) before
 * variables like `template` are assigned in beforeAll/beforeEach hooks.
 */

/**
 * Helper to check if a CallExpression is a describe block
 * Handles: describe(), describe.skip(), describe.only(), describe.each()()
 */
const isDescribe = (node) => {
  const name = node.callee.name;
  const objectName = node.callee.object?.name;
  // Handle describe.each()() - nested CallExpression
  const nestedObjectName = node.callee.callee?.object?.name;
  const nestedName = node.callee.callee?.name;

  return (
    name === "describe" ||
    objectName === "describe" ||
    nestedObjectName === "describe" ||
    nestedName === "describe"
  );
};

/**
 * Helper to check if a CallExpression is a test block
 * Handles: it(), test(), it.skip(), it.only(), it.each()(), test.each()()
 */
const isTest = (node) => {
  const name = node.callee.name;
  const objectName = node.callee.object?.name;
  // Handle it.each()() and test.each()()
  const nestedObjectName = node.callee.callee?.object?.name;
  const nestedName = node.callee.callee?.name;

  const testNames = ["it", "test"];

  return (
    testNames.includes(name) ||
    testNames.includes(objectName) ||
    testNames.includes(nestedObjectName) ||
    testNames.includes(nestedName)
  );
};

/**
 * Helper to check if a CallExpression is a Jest hook
 */
const isHook = (node) => {
  const name = node.callee.name;
  return ["beforeAll", "beforeEach", "afterAll", "afterEach"].includes(name);
};

export default {
  rules: {
    /**
     * Rule: no-template-in-describe
     *
     * Prevents accessing `template` variable in describe blocks where it
     * would be undefined. Template is typically assigned in beforeAll/beforeEach.
     *
     * ❌ Bad:
     * describe('Stack', () => {
     *   template.hasResourceProperties('AWS::Lambda::Function', {});
     * });
     *
     * ✅ Good:
     * describe('Stack', () => {
     *   beforeAll(() => {
     *     template = Template.fromStack(stack);
     *   });
     *   it('should have lambda', () => {
     *     template.hasResourceProperties('AWS::Lambda::Function', {});
     *   });
     * });
     */
    "no-template-in-describe": {
      meta: {
        type: "problem",
        schema: [],
        docs: {
          description: "Disallow template access outside of test functions",
          category: "Possible Errors",
          recommended: true,
        },
        messages: {
          noTemplateInDescribe:
            'Do not access "template" in describe blocks. ' +
            "Move this code into a test function (it/test) or beforeAll/beforeEach.",
        },
      },
      create(context) {
        let describeDepth = 0;
        let testDepth = 0;
        let hookDepth = 0;

        /**
         * Check if the node is inside a helper function that receives
         * template as a parameter (which is a valid pattern)
         */
        const isInHelperFunction = (node) => {
          let parent = node.parent;
          while (parent) {
            if (
              parent.type === "ArrowFunctionExpression" ||
              parent.type === "FunctionExpression" ||
              parent.type === "FunctionDeclaration"
            ) {
              const params = parent.params || [];
              if (
                params.some(
                  (param) =>
                    // Direct parameter: (template) => {}
                    (param.type === "Identifier" &&
                      param.name === "template") ||
                    // Destructured parameter: ({ template }) => {}
                    (param.type === "ObjectPattern" &&
                      param.properties.some(
                        (prop) =>
                          prop.type === "Property" &&
                          prop.key.type === "Identifier" &&
                          prop.key.name === "template",
                      )),
                )
              ) {
                return true;
              }
            }
            parent = parent.parent;
          }
          return false;
        };

        /**
         * Check if we're in a describe block but NOT in a test or hook
         */
        const isInDescribeBodyOnly = () => {
          return describeDepth > 0 && testDepth === 0 && hookDepth === 0;
        };

        return {
          CallExpression(node) {
            // Track entry into describe/test/hook blocks
            if (isDescribe(node)) describeDepth++;
            if (isTest(node)) testDepth++;
            if (isHook(node)) hookDepth++;

            // Check for template.* calls in describe body
            if (isInDescribeBodyOnly()) {
              const isTemplateMethodCall =
                node.callee.type === "MemberExpression" &&
                node.callee.object?.name === "template";

              if (isTemplateMethodCall && !isInHelperFunction(node)) {
                context.report({
                  node,
                  messageId: "noTemplateInDescribe",
                });
              }
            }
          },

          "CallExpression:exit"(node) {
            // Track exit from describe/test/hook blocks
            if (isDescribe(node)) describeDepth--;
            if (isTest(node)) testDepth--;
            if (isHook(node)) hookDepth--;
          },
        };
      },
    },

    /**
     * Rule: no-iife-in-describe
     *
     * Prevents IIFEs in describe blocks that execute during module
     * initialization when variables may be undefined.
     *
     * ❌ Bad:
     * describe('Stack', () => {
     *   (() => {
     *     // This runs immediately, before beforeAll!
     *     console.log(template); // undefined!
     *   })();
     * });
     *
     * ✅ Good:
     * describe('Stack', () => {
     *   beforeAll(() => {
     *     // Setup code here
     *   });
     * });
     */
    "no-iife-in-describe": {
      meta: {
        type: "problem",
        schema: [],
        docs: {
          description:
            "Disallow immediately invoked function expressions in describe blocks",
          category: "Possible Errors",
          recommended: true,
        },
        messages: {
          noIifeInDescribe:
            "Do not use IIFE in describe blocks. " +
            "This executes during initialization when variables may be undefined. " +
            "Move this code into beforeAll/beforeEach or a test function.",
        },
      },
      create(context) {
        let describeDepth = 0;
        let testDepth = 0;
        let hookDepth = 0;

        /**
         * Check if we're in a describe block but NOT in a test or hook
         */
        const isInDescribeBodyOnly = () => {
          return describeDepth > 0 && testDepth === 0 && hookDepth === 0;
        };

        return {
          CallExpression(node) {
            // Track entry into describe/test/hook blocks
            if (isDescribe(node)) describeDepth++;
            if (isTest(node)) testDepth++;
            if (isHook(node)) hookDepth++;

            // Check for IIFE pattern: (function() {})() or (() => {})()
            if (isInDescribeBodyOnly()) {
              const isIife =
                node.callee.type === "FunctionExpression" ||
                node.callee.type === "ArrowFunctionExpression";

              if (isIife) {
                context.report({
                  node,
                  messageId: "noIifeInDescribe",
                });
              }
            }
          },

          "CallExpression:exit"(node) {
            // Track exit from describe/test/hook blocks
            if (isDescribe(node)) describeDepth--;
            if (isTest(node)) testDepth--;
            if (isHook(node)) hookDepth--;
          },
        };
      },
    },

    /**
     * Rule: no-template-literal-title
     *
     * Prevents using template literals with variables in describe/it titles
     * which can lead to confusing test output when variables are undefined.
     *
     * ❌ Bad:
     * describe(`Testing ${stackName}`, () => {});
     *
     * ✅ Good:
     * describe('Testing MyStack', () => {});
     * describe.each([...])('Testing %s', (name) => {});
     */
    "no-template-literal-title": {
      meta: {
        type: "problem",
        schema: [],
        docs: {
          description:
            "Disallow template literals with expressions in test titles",
          category: "Possible Errors",
          recommended: true,
        },
        messages: {
          noTemplateLiteralTitle:
            "Do not use template literals with variables in test titles. " +
            "The variable may be undefined at describe-time. " +
            "Use describe.each/it.each for parameterized tests instead.",
        },
      },
      create(context) {
        return {
          CallExpression(node) {
            // Check if this is a describe or test call
            if (!isDescribe(node) && !isTest(node)) {
              return;
            }

            // Get the first argument (the title)
            const titleArg = node.arguments[0];

            // Check if it's a template literal with expressions
            if (
              titleArg?.type === "TemplateLiteral" &&
              titleArg.expressions.length > 0
            ) {
              context.report({
                node: titleArg,
                messageId: "noTemplateLiteralTitle",
              });
            }
          },
        };
      },
    },
  },
};
